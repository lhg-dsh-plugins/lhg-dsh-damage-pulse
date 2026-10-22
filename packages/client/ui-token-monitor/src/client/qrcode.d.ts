declare module 'qrcode/lib/browser.js' {
  export function toString(text: string, options?: Record<string, unknown>): Promise<string>
}
