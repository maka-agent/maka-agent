import { FileCode, FileImage, FileText, FileType, Paperclip, type LucideIcon } from './icons.js';
import type { AttachmentRef } from '@maka/core';

/** Per-kind lucide icon for attachment chips and thumbnails. Replaces the
 *  emoji labels (🖼📄📘💻📎) with a consistent icon set. */
export const ATTACHMENT_KIND_ICON: Record<AttachmentRef['kind'], LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  doc: FileType,
  code: FileCode,
  other: Paperclip,
};

export function AttachmentKindIcon(props: { kind: AttachmentRef['kind']; className?: string }) {
  const Icon = ATTACHMENT_KIND_ICON[props.kind];
  return <Icon className={props.className} aria-hidden="true" />;
}
