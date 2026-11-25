import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { MousePointerClickIcon, XIcon } from "lucide-react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import "./maximizedChat.css";

/**
 * g3code: the draft's page annotations as one "N annotations" chip above the message box, like
 * the ChatGPT app. Hovering lists them, numbered like their markers on the page, with delete
 * and delete-all. They join the message (as context references) only when it is sent.
 */
export function ComposerAnnotationsChip(props: {
  annotations: ReadonlyArray<PreviewAnnotationPayload>;
  images: ReadonlyArray<ComposerImageAttachment>;
  onRemove: (annotationId: string) => void;
  onRemoveAll: () => void;
}) {
  const gt = useGT();
  const count = props.annotations.length;
  if (count === 0) return null;
  return (
    <div className="flex px-3 pt-3">
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={80}
          closeDelay={160}
          render={
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 font-medium text-foreground text-xs hover:bg-accent"
            />
          }
        >
          <MousePointerClickIcon data-g3-annotation-icon="" className="size-3.5" />
          {gt(
            "{count, plural, one {{formattedCount} annotation} other {{formattedCount} annotations}}",
            { count, formattedCount: count.toLocaleString() },
          )}
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" sideOffset={6} padding="none" className="w-80">
          <ul className="max-h-80 overflow-y-auto py-1">
            {props.annotations.map((annotation, index) => {
              const screenshot =
                annotation.screenshot?.dataUrl ||
                props.images.find((image) => image.id === annotation.id)?.previewUrl;
              const comment = annotation.comment.trim();
              return (
                <li
                  key={annotation.id}
                  className="group flex items-start gap-2.5 px-3 py-2 hover:bg-accent/60"
                >
                  <span
                    data-g3-annotation-badge=""
                    className="mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center px-1 font-semibold text-2xs text-white"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-3 whitespace-pre-wrap wrap-break-word text-foreground text-sm">
                      {comment || gt("No comment")}
                    </p>
                    <p className="truncate text-muted-foreground text-xs">
                      {annotation.pageTitle?.trim() || annotation.pageUrl}
                    </p>
                  </div>
                  {screenshot ? (
                    <img
                      src={screenshot}
                      alt=""
                      className="size-9 shrink-0 rounded-md border border-border object-cover"
                    />
                  ) : null}
                  <button
                    type="button"
                    aria-label={gt("Delete annotation")}
                    className="-mr-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => props.onRemove(annotation.id)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end border-border border-t px-2 py-1.5">
            <button
              type="button"
              className="rounded-md px-2 py-1 font-medium text-destructive-foreground text-xs hover:bg-destructive/10"
              onClick={props.onRemoveAll}
            >
              {gt("Delete all")}
            </button>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
