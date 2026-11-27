import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { MousePointerClickIcon, XIcon } from "lucide-react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import "./maximizedChat.css";

/**
 * g3code: the draft's page annotations as one "N annotations" chip above the message box, like
 * the ChatGPT app. Hovering lists them, numbered like their markers on the page, with delete
 * and delete-all. They join the message (as context references) only when it is sent.
 */
export function ComposerAnnotationsChip(props: {
  annotations: ReadonlyArray<PreviewAnnotationPayload>;
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
  return (
    <div className="mb-2 flex">
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={80}
          closeDelay={160}
          render={
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-transparent pr-2.5 pl-2 font-medium text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
            />
          }
        >
          <MousePointerClickIcon data-g3-annotation-icon="" className="size-3.5" />
          {label}
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" sideOffset={6} padding="none" className="w-72">
          <div className="flex items-center justify-between py-1.5 pr-1.5 pl-3">
            <span className="font-medium text-muted-foreground text-xs">{label}</span>
            <button
              type="button"
              className="rounded-md px-2 py-1 font-medium text-destructive-foreground text-xs hover:bg-destructive/10"
              onClick={props.onRemoveAll}
            >
              {gt("Delete all")}
            </button>
          </div>
          <ul className="max-h-72 overflow-y-auto px-1 pb-1">
            {props.annotations.map((annotation, index) => {
              const comment = annotation.comment.trim();
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
    </div>
  );
}
