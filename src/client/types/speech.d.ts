// The Web Speech API's recognizer. TypeScript's DOM library has its events but not the recognizer
// itself, which browsers ship as SpeechRecognition or, in Chrome and Safari, webkitSpeechRecognition.
// This is the part dictation.ts uses (https://webaudio.github.io/web-speech-api/#speechreco-section).
interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface Window {
  SpeechRecognition?: new () => SpeechRecognition;
  webkitSpeechRecognition?: new () => SpeechRecognition;
}
