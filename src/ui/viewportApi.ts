// Bridge so non-React code (the AI agent) can grab images of the viewport.
export type ViewName = 'current' | 'iso' | 'top' | 'front' | 'right' | 'back' | 'left' | 'bottom';

type CaptureFn = (view: ViewName, focusId?: string) => string; // base64 JPEG, no prefix

let captureImpl: CaptureFn | null = null;

export const viewportApi = {
  register(fn: CaptureFn | null) {
    captureImpl = fn;
  },
  capture(view: ViewName = 'current', focusId?: string): string | null {
    return captureImpl ? captureImpl(view, focusId) : null;
  },
};
