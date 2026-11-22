// The six directions a tracing can be taken from: which side of the object
// faces up on the tablet. Shared by Fabbrico and the pad page.

export const VIEWS = ['top', 'bottom', 'front', 'back', 'left', 'right'] as const;
export type View = (typeof VIEWS)[number];

/** How to place the object on the tablet for each view ("you" = sitting at the tablet's bottom edge). */
export const VIEW_HINTS: Record<View, string> = {
  top: 'standing normally, its front towards you',
  bottom: 'upside down, its front away from you',
  front: 'lying on its back, its top away from you',
  back: 'lying on its front, its top away from you',
  right: 'lying on its left side, its top away from you',
  left: 'lying on its right side, its top away from you',
};
