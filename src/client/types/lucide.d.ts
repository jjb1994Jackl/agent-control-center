// lucide ships types for its entry module only, and that module carries every icon with it. The
// page imports the parts of its ES build it uses, one file each (src/client/js/icons.ts):
//   icons/<name>.js       one icon: [tag, attributes, children], as replaceElement takes it
//   replaceElement.js     puts an icon in the place of its <i data-lucide="name"> placeholder
//                         (what createIcons does for each placeholder), keeping its attributes
//   iconsAndAliases.js    every icon by its name ("FileCheck2"): fetched on its own, and only
//                         when a name is asked for that the page's own icons do not have
declare module 'lucide/dist/esm/icons/*.js' {
  const icon: readonly unknown[];
  export default icon;
}
declare module 'lucide/dist/esm/replaceElement.js' {
  export default function replaceElement(element: Element, options: { nameAttr: string; icons: Record<string, unknown>; attrs: Record<string, string | number> }): unknown;
}
declare module 'lucide/dist/esm/iconsAndAliases.js' {
  const all: Record<string, unknown>;
  export = all;
}
