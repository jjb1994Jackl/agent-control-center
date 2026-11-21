// @highlightjs/cdn-assets ships no types. This is the part of its ES build the page uses, as
// documented at https://highlightjs.readthedocs.io/en/latest/api.html. The ES build carries the
// same 36 languages as the highlight.min.js the page loaded from /vendor before.
declare module '@highlightjs/cdn-assets/es/highlight.min.js' {
  interface HighlightResult { value: string; language?: string }
  interface HighlightOptions { language: string; ignoreIllegals?: boolean }
  interface HLJSApi {
    highlight(code: string, options: HighlightOptions): HighlightResult;
    getLanguage(name: string): object | undefined;
    listLanguages(): string[];
  }
  const hljs: HLJSApi;
  export default hljs;
}
