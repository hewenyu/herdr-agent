import { object, string } from "./api.js";

/** Feishu post paragraphs match SDK channel/normalize converters: locale -> title/content(_v2). */
export function postText(raw: unknown, botOpenId: string): { text: string; mentionedBot: boolean } {
  const root = object(raw);
  const localized = root.post ? object(root.post) : root;
  const direct = Array.isArray(localized.content) || Array.isArray(localized.content_v2);
  const locales = ["zh_cn", "en_us", ...Object.keys(localized).sort()];
  const body = direct
    ? localized
    : locales
        .map((locale) => object(localized[locale]))
        .find(
          (candidate) => Array.isArray(candidate.content) || Array.isArray(candidate.content_v2),
        );
  if (!body) throw new Error("Invalid rich text body");
  const paragraphs =
    Array.isArray(body.content_v2) && body.content_v2.length ? body.content_v2 : body.content;
  if (!Array.isArray(paragraphs)) throw new Error("Invalid rich text paragraphs");
  const lines = [string(body.title)];
  let mentionedBot = false;
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) throw new Error("Invalid rich text paragraph");
    const parts: string[] = [];
    for (const value of paragraph) {
      const node = object(value);
      switch (node.tag) {
        case "text":
        case "md":
        case "code_block":
          parts.push(string(node.text));
          break;
        case "a": {
          const label = string(node.text),
            href = string(node.href);
          parts.push(label && href && label !== href ? `${label} (${href})` : label || href);
          break;
        }
        case "at":
          if (botOpenId && string(node.user_id) === botOpenId) mentionedBot = true;
          else parts.push(string(node.user_name) || string(node.text) || string(node.user_id));
          break;
        default:
          break; // Resource keys/alt text are not downloaded or converted into user instructions.
      }
    }
    lines.push(parts.join(""));
  }
  return { text: lines.filter(Boolean).join("\n").trim(), mentionedBot };
}
