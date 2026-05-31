import { Lexer } from "marked";

import type { JsonLike } from "../../types.js";

type FeishuPostElement = { readonly [key: string]: JsonLike };
type MarkdownToken = Record<string, unknown>;

export function createFeishuPostContentFromMarkdown(text: string): JsonLike {
  const content = renderBlockTokens(Lexer.lex(text) as unknown as MarkdownToken[]);
  return {
    zh_cn: {
      content: content.length > 0 ? content : [[textElement(text)]],
    },
  };
}

function renderBlockTokens(tokens: readonly MarkdownToken[]): FeishuPostElement[][] {
  return tokens.flatMap((token) => renderBlockToken(token));
}

function renderBlockToken(token: MarkdownToken): FeishuPostElement[][] {
  switch (token.type) {
    case "space":
      return [];
    case "paragraph":
    case "text":
      return renderInlineTokens(inlineTokensFor(token));
    case "heading":
      return renderHeading(token);
    case "list":
      return renderList(token);
    case "blockquote":
      return renderBlockTokens(arrayTokens(token.tokens)).map((line) => [textElement("> "), ...line]);
    case "code":
      return [
        [
          {
            tag: "code_block",
            language: stringValue(token.lang),
            text: stringValue(token.text),
          },
        ],
      ];
    case "hr":
      return [[{ tag: "hr" }]];
    default:
      return stringValue(token.text) || stringValue(token.raw) ? [[textElement(stringValue(token.text) || stringValue(token.raw))]] : [];
  }
}

function renderHeading(token: MarkdownToken): FeishuPostElement[][] {
  return renderInlineTokens(inlineTokensFor(token), ["bold"]).map((line, index) => (index === 0 ? [textElement(`${"#".repeat(numberValue(token.depth, 1))} `, ["bold"]), ...line] : line));
}

function renderList(token: MarkdownToken): FeishuPostElement[][] {
  const ordered = token.ordered === true;
  const start = numberValue(token.start, 1);
  return arrayTokens(token.items).flatMap((item, index) => {
    const marker = ordered ? `${start + index}. ` : "- ";
    const rendered = renderListItem(item);
    return rendered.map((line, lineIndex) => [textElement(lineIndex === 0 ? marker : "  "), ...line]);
  });
}

function renderListItem(token: MarkdownToken): FeishuPostElement[][] {
  const childTokens = arrayTokens(token.tokens);
  if (childTokens.length > 0) {
    return renderBlockTokens(childTokens);
  }

  const text = stringValue(token.text);
  return text ? renderInlineTokens(Lexer.lexInline(text) as unknown as MarkdownToken[]) : [[]];
}

function renderInlineTokens(tokens: readonly MarkdownToken[], inheritedStyle: readonly string[] = []): FeishuPostElement[][] {
  const lines: FeishuPostElement[][] = [[]];
  const current = () => lines[lines.length - 1]!;

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const nested = arrayTokens(token.tokens);
        if (nested.length > 0) {
          appendInlineLines(lines, renderInlineTokens(nested, inheritedStyle));
        } else {
          pushText(current(), stringValue(token.text), inheritedStyle);
        }
        break;
      }
      case "codespan":
        pushText(current(), stringValue(token.text), [...inheritedStyle, "codeInline"]);
        break;
      case "strong":
        appendInlineLines(lines, renderInlineTokens(inlineTokensFor(token), [...inheritedStyle, "bold"]));
        break;
      case "em":
        appendInlineLines(lines, renderInlineTokens(inlineTokensFor(token), [...inheritedStyle, "italic"]));
        break;
      case "del":
        appendInlineLines(lines, renderInlineTokens(inlineTokensFor(token), [...inheritedStyle, "lineThrough"]));
        break;
      case "link":
        current().push({
          tag: "a",
          text: inlinePlainText(inlineTokensFor(token)) || stringValue(token.text) || stringValue(token.href),
          href: stringValue(token.href),
        });
        break;
      case "br":
        lines.push([]);
        break;
      case "image":
        pushText(current(), stringValue(token.text) ? `[image: ${stringValue(token.text)}]` : "[image]", inheritedStyle);
        break;
      default:
        pushText(current(), stringValue(token.text) || stringValue(token.raw), inheritedStyle);
        break;
    }
  }

  return lines.filter((line) => line.length > 0);
}

function appendInlineLines(target: FeishuPostElement[][], source: FeishuPostElement[][]): void {
  if (source.length === 0) {
    return;
  }

  target[target.length - 1]!.push(...source[0]!);
  for (const line of source.slice(1)) {
    target.push([...line]);
  }
}

function inlineTokensFor(token: MarkdownToken): MarkdownToken[] {
  const tokens = arrayTokens(token.tokens);
  if (tokens.length > 0) {
    return tokens;
  }

  const text = stringValue(token.text);
  return text ? (Lexer.lexInline(text) as unknown as MarkdownToken[]) : [];
}

function inlinePlainText(tokens: readonly MarkdownToken[]): string {
  return tokens
    .map((token) => {
      const nested = arrayTokens(token.tokens);
      if (nested.length > 0) {
        return inlinePlainText(nested);
      }
      return stringValue(token.text);
    })
    .join("");
}

function pushText(line: FeishuPostElement[], text: string, styles: readonly string[] = []): void {
  if (text) {
    line.push(textElement(text, styles));
  }
}

function textElement(text: string, styles: readonly string[] = []): FeishuPostElement {
  const style = [...new Set(styles.filter(Boolean))];
  if (style.length > 0) {
    return {
      tag: "text",
      text,
      style,
    };
  }

  return {
    tag: "text",
    text,
  };
}

function arrayTokens(value: unknown): MarkdownToken[] {
  return Array.isArray(value) ? value.filter((entry): entry is MarkdownToken => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
