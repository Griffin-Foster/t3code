import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { MousePointerClickIcon, XIcon } from "lucide-react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import "./maximizedChat.css";

/**
 * g3code: the draft's page annotations as one "N annotations" chip above the message box, like
 * the ChatGPT app. Hovering lists them, numbered like their markers on the page, with delete
 * and delete-all, and each screenshot opens enlarged. They join the message (as context
 * references) only when it is sent.
 */
export function ComposerAnnotationsChip(props: {
  annotations: ReadonlyArray<PreviewAnnotationPayload>;
  images: ReadonlyArray<ComposerImageAttachment>;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onRemove: (annotationId: string) => void;
  onRemoveAll: () => void;
}) {
  const gt = useGT();
  const count = props.annotations.length;
  if (count === 0) return null;
  const label = gt(
    "{count, plural, one {{formattedCount} annotation} other {{formattedCount} annotations}}",
    { count, formattedCount: count.toLocaleString() },
  );
  const screenshotOf = (annotation: PreviewAnnotationPayload): string | null =>
    annotation.screenshot?.dataUrl ||
    props.images.find((image) => image.id === annotation.id)?.previewUrl ||
    null;
  const titleOf = (annotation: PreviewAnnotationPayload, index: number): string =>
    `${index + 1}. ${annotation.comment.trim() || annotation.pageTitle?.trim() || annotation.pageUrl}`;
  // Opens the screenshot enlarged; the viewer steps through every annotation's screenshot.
  const expand = (annotationId: string) => {
    const shots = props.annotations.flatMap((annotation, index) => {
      const src = screenshotOf(annotation);
      return src ? [{ id: annotation.id, src, name: titleOf(annotation, index) }] : [];
    });
    const index = shots.findIndex((shot) => shot.id === annotationId);
    if (index < 0) return;
    props.onExpandImage({ images: shots.map(({ src, name }) => ({ src, name })), index });
  };
  return (
    <div className="mb-2 flex">
      {/* One pill: the hover trigger, then a delete-all X that slides open inside it on hover. */}
      <div className="group/annotations inline-flex h-7 items-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground has-data-popup-open:bg-accent has-data-popup-open:text-foreground">
        <Popover>
          <PopoverTrigger
            openOnHover
            delay={80}
            closeDelay={160}
            render={
              <button
                type="button"
                className="inline-flex h-full items-center gap-1.5 rounded-full bg-transparent pr-2.5 pl-2 font-medium text-xs"
              />
            }
          >
            <MousePointerClickIcon data-g3-annotation-icon="" className="size-3.5" />
            {label}
          </PopoverTrigger>
          <PopoverPopup side="top" align="start" sideOffset={6} padding="none" className="w-80">
            <ul className="max-h-72 overflow-y-auto p-1">
              {props.annotations.map((annotation, index) => {
                const comment = annotation.comment.trim();
                const screenshot = screenshotOf(annotation);
                return (
                  <li
                    key={annotation.id}
                    className="group flex items-start gap-2.5 rounded-lg py-1.5 pr-1 pl-2 hover:bg-accent"
                  >
                    <span
                      data-g3-annotation-badge=""
                      className="mt-px flex h-5 min-w-5 shrink-0 items-center justify-center px-1 font-semibold text-2xs text-white"
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className={
                          comment
                            ? "line-clamp-2 wrap-break-word text-foreground text-sm leading-5"
                            : "text-muted-foreground text-sm italic leading-5"
                        }
                      >
                        {comment || gt("No comment")}
                      </p>
                      <p className="truncate text-muted-foreground text-xs leading-4">
                        {annotation.pageTitle?.trim() || annotation.pageUrl}
                      </p>
                    </div>
                    {screenshot ? (
                      <button
                        type="button"
                        aria-label={gt("Enlarge screenshot")}
                        className="h-10 w-14 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border bg-background"
                        onClick={() => expand(annotation.id)}
                      >
                        <img
                          src={screenshot}
                          alt=""
                          className="size-full object-cover object-top-left"
                        />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={gt("Delete annotation")}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background/60 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => props.onRemove(annotation.id)}
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </PopoverPopup>
        </Popover>
        <span className="grid w-0 overflow-hidden opacity-0 transition-[width,margin,opacity] duration-200 ease-out focus-within:-ml-1 focus-within:mr-1 focus-within:w-5 focus-within:opacity-100 group-hover/annotations:-ml-1 group-hover/annotations:mr-1 group-hover/annotations:w-5 group-hover/annotations:opacity-100">
          <button
            type="button"
            aria-label={gt("Delete all annotations")}
            className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-background/70 hover:text-foreground"
            onClick={props.onRemoveAll}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      </div>
    </div>
  );
}
