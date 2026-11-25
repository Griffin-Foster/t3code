/**
 * g3code updates itself from its git checkout instead of installing T3 Code release builds, which
 * would replace it with stock T3 Code. Same state shape as DesktopUpdates, driving
 * `g3code/update.sh`; used only when the g3code launcher sets G3CODE_REPO.
 */
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper runs the g3code update script as a Node child process.
// @effect-diagnostics globalFetchInEffect:off -- One unauthenticated GitHub read for release notes; failures fall back to no notes.
import type {
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import { DesktopUpdates } from "./DesktopUpdates.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const STARTUP_CHECK_DELAY = Duration.seconds(20);
const POLL_INTERVAL = Duration.hours(4);
const RELEASE_REPOSITORY = "pingdotgg/t3code";

/** The checkout g3code runs from, when the g3code launcher started this app. */
export function g3codeRepo(): string | undefined {
  const repo = process.env.G3CODE_REPO?.trim();
  return repo ? repo : undefined;
}

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("g3code-updater");

interface ScriptResult {
  readonly code: number;
  readonly fields: ReadonlyMap<string, string>;
  readonly lastLine: string | null;
}

const stripV = (tag: string | undefined) => (tag ? tag.replace(/^v/, "") : undefined);

function parseFields(output: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^([a-z]+)=(.*)$/.exec(line);
    if (match?.[1]) fields.set(match[1], match[2] ?? "");
  }
  return fields;
}

export const make = Effect.fn("G3codeUpdates.make")(function* (repo: string) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const script = environment.path.join(repo, "g3code/update.sh");

  const stateRef = yield* Ref.make<DesktopUpdateState>({
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, "latest"),
    enabled: true,
    status: "idle",
  });
  const changes = yield* PubSub.sliding<DesktopUpdateState>(16);
  const mutex = yield* Semaphore.make(1);
  const activeActionRef = yield* Ref.make<Option.Option<"check" | "download" | "install">>(
    Option.none(),
  );

  const emitState = Ref.get(stateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );
  const setState = (f: (state: DesktopUpdateState) => DesktopUpdateState) =>
    mutex
      .withPermits(1)(
        Ref.updateAndGet(stateRef, f).pipe(Effect.tap((state) => PubSub.publish(changes, state))),
      )
      .pipe(Effect.tap(() => emitState));

  /** Runs the script; `::progress <percent> <label>` lines are reported as they arrive. */
  const run = (
    args: ReadonlyArray<string>,
    onProgress?: (percent: number, label: string) => void,
    detached = false,
  ) =>
    Effect.callback<ScriptResult>((resume) => {
      const child = NodeChildProcess.spawn("/bin/bash", [script, ...args], {
        cwd: repo,
        env: { ...process.env, G3CODE_REPO: repo },
        detached,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let pending = "";
      let lastLine: string | null = null;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const progress = /^::progress (\d+) (.*)$/.exec(line);
          if (progress) onProgress?.(Number(progress[1]), progress[2] ?? "");
          const report = /^::(?:error|needs-help) (.*)$/.exec(line);
          if (report) lastLine = report[1] ?? null;
        }
      });
      child.stderr.resume();
      child.on("error", (error) =>
        resume(Effect.succeed({ code: -1, fields: new Map(), lastLine: error.message })),
      );
      child.on("close", (code) =>
        resume(Effect.succeed({ code: code ?? -1, fields: parseFields(output), lastLine })),
      );
      return Effect.sync(() => {
        child.kill("SIGTERM");
      });
    });

  /** Fetches the release's notes from GitHub for the update popover; empty when offline. */
  const releaseNotesFor = (version: string) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(
          `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/v${version}`,
          { headers: { accept: "application/vnd.github+json" } },
        );
        if (!response.ok) return null;
        return (await response.json()) as { body?: string; published_at?: string };
      },
      catch: () => "release notes unavailable",
    }).pipe(
      Effect.map((release) =>
        release?.body
          ? normalizeDesktopUpdateReleaseNotes(
              release.body,
              version,
              "latest",
              release.published_at,
            )
          : { releaseNotes: [], omittedReleaseCount: 0 },
      ),
      Effect.orElseSucceed(() => ({ releaseNotes: [], omittedReleaseCount: 0 })),
    );

  /** Applies the script's saved progress, which survives restarts. */
  const fromSavedStatus = (
    fields: ReadonlyMap<string, string>,
    state: DesktopUpdateState,
  ): DesktopUpdateState => {
    const current = stripV(fields.get("current")) ?? state.currentVersion;
    const target = stripV(fields.get("target")) ?? null;
    const message = fields.get("message") || null;
    const base = { ...state, currentVersion: current, enabled: true, downloadPercent: null };
    switch (fields.get("phase")) {
      case "ready":
        return {
          ...base,
          status: "downloaded",
          availableVersion: target,
          downloadedVersion: target,
          downloadPercent: 100,
          message: null,
          errorContext: null,
          canRetry: false,
        };
      case "needs-help":
      case "failed":
        return target
          ? {
              ...base,
              status: "error",
              availableVersion: target,
              downloadedVersion: null,
              message,
              errorContext: "download",
              canRetry: true,
            }
          : { ...base, status: "idle", message };
      case "preparing":
      case "installing":
        // The app quit partway; offer the update again.
        return target
          ? {
              ...base,
              status: "available",
              availableVersion: target,
              message: null,
              errorContext: null,
            }
          : { ...base, status: "idle" };
      default:
        return { ...base, status: "idle", message: null, errorContext: null };
    }
  };

  /** Runs one update action at a time; `busy` answers while another is running. */
  const withAction = <A>(
    action: "check" | "download" | "install",
    busy: Effect.Effect<A>,
    effect: Effect.Effect<A>,
  ): Effect.Effect<A> =>
    Ref.modify(
      activeActionRef,
      (active): [boolean, Option.Option<"check" | "download" | "install">] =>
        Option.isSome(active) ? [false, active] : [true, Option.some(action)],
    ).pipe(
      Effect.flatMap((started) =>
        started ? effect.pipe(Effect.ensuring(Ref.set(activeActionRef, Option.none()))) : busy,
      ),
    );

  const loadSavedStatus = run(["status"]).pipe(
    Effect.flatMap((result) => setState((state) => fromSavedStatus(result.fields, state))),
  );

  const check = (reason: string): Effect.Effect<DesktopUpdateCheckResult> =>
    withAction<DesktopUpdateCheckResult>(
      "check",
      Ref.get(stateRef).pipe(Effect.map((state) => ({ checked: false, state }))),
      Effect.gen(function* () {
        yield* logInfo("checking for a newer T3 Code release", { reason });
        const before = yield* Ref.get(stateRef);
        // A prepared or stuck update keeps showing until it's installed or cancelled.
        const holding = before.status === "downloaded" || before.status === "error";
        if (!holding) yield* setState((state) => ({ ...state, status: "checking", message: null }));
        const result = yield* run(["check"]);
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const current = stripV(result.fields.get("current"));
        const latest = stripV(result.fields.get("latest"));
        if (result.code !== 0 || !current || !latest) {
          if (holding) return { checked: true, state: yield* Ref.get(stateRef) };
          const state = yield* setState((state) => ({
            ...state,
            status: "error",
            errorContext: "check",
            canRetry: true,
            checkedAt,
            message: result.lastLine ?? "Couldn't look for g3code updates.",
          }));
          return { checked: true, state };
        }
        if (holding) {
          return {
            checked: true,
            state: yield* setState((state) => ({ ...state, currentVersion: current, checkedAt })),
          };
        }
        if (compareSemverVersions(latest, current) <= 0) {
          const state = yield* setState((state) => ({
            ...state,
            status: "up-to-date",
            currentVersion: current,
            availableVersion: null,
            releaseNotes: [],
            omittedReleaseCount: 0,
            errorContext: null,
            checkedAt,
          }));
          return { checked: true, state };
        }
        const notes = yield* releaseNotesFor(latest);
        const state = yield* setState((state) => ({
          ...state,
          status: "available",
          currentVersion: current,
          availableVersion: latest,
          downloadedVersion: null,
          ...notes,
          errorContext: null,
          canRetry: false,
          checkedAt,
        }));
        return { checked: true, state };
      }),
    );

  /** Prepares the update, or continues one a helper thread was fixing. */
  const download: Effect.Effect<DesktopUpdateActionResult> = Effect.gen(function* () {
    const before = yield* Ref.get(stateRef);
    const target = before.availableVersion;
    if (!target || (before.status !== "available" && before.status !== "error")) {
      return { accepted: false, completed: before.status === "downloaded", state: before };
    }
    const continuing = before.status === "error" && before.errorContext === "download";
    const started = yield* withAction(
      "download",
      Effect.succeed(false),
      Effect.gen(function* () {
        yield* setState((state) => ({
          ...state,
          status: "downloading",
          downloadPercent: 0,
          message: null,
          errorContext: null,
        }));
        const context = yield* Effect.context<never>();
        const result = yield* run(
          continuing ? ["resume"] : ["prepare", `v${target}`],
          (percent, label) => {
            void Effect.runPromiseWith(context)(
              setState((state) => ({ ...state, downloadPercent: percent, message: label })),
            );
          },
        );
        if (result.code !== 0) {
          yield* logWarning("the update needs attention", { message: result.lastLine ?? "" });
        }
        yield* loadSavedStatus;
        return true;
      }),
    );
    const state = yield* Ref.get(stateRef);
    return { accepted: started, completed: state.status === "downloaded", state };
  });

  /** Hands over to the script, which quits this app, installs the update and reopens g3code. */
  const install: Effect.Effect<DesktopUpdateActionResult> = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    if (state.status !== "downloaded") return { accepted: false, completed: false, state };
    return yield* withAction(
      "install",
      Effect.succeed({ accepted: false, completed: false, state }),
      // The script checks it's safe, then quits this app from a process of its own.
      run(["install"], undefined, true).pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed({ accepted: true, completed: true, state })
            : setState((current) => ({
                ...current,
                status: "error",
                errorContext: "install",
                canRetry: true,
                message: result.lastLine ?? "Couldn't install the g3code update.",
              })).pipe(Effect.map((next) => ({ accepted: true, completed: false, state: next }))),
        ),
      ),
    );
  });

  const configure = Effect.gen(function* () {
    yield* Ref.set(desktopState.canInstallUpdates, true);
    yield* loadSavedStatus;
    yield* Effect.sleep(STARTUP_CHECK_DELAY).pipe(
      Effect.andThen(check("startup")),
      Effect.andThen(
        Effect.sleep(POLL_INTERVAL).pipe(Effect.andThen(check("poll")), Effect.forever),
      ),
      Effect.forkScoped,
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(stateRef),
    isActionActive: Ref.get(activeActionRef).pipe(Effect.map(Option.isSome)),
    isInstallActive: Ref.get(activeActionRef).pipe(
      Effect.map((action) => Option.isSome(action) && action.value === "install"),
    ),
    subscribe: mutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return {
          latest: yield* Ref.get(stateRef),
          changes: Stream.fromSubscription(subscription),
        };
      }),
    ),
    emitState,
    disabledReason: Effect.succeedNone,
    configure,
    // g3code follows T3 Code's stable releases only.
    setChannel: Effect.fn("G3codeUpdates.setChannel")(function* () {
      return yield* Ref.get(stateRef);
    }),
    check: Effect.fn("G3codeUpdates.check")(function* (reason: string) {
      return yield* check(reason);
    }),
    download,
    install,
    installPrepared: Effect.fn("G3codeUpdates.installPrepared")(function* () {
      const result = yield* install;
      return { ...result, failed: !result.accepted };
    }),
  });
});
