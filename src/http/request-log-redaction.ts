const TEXT_BODY_FIELDS: Record<string, string> = {
  text: "text",
  reason: "reason",
  stop_reason: "reason",
  stopReason: "reason",
  initial_comment: "comment",
  initialComment: "comment",
  alt_text: "alt-text",
  altText: "alt-text",
  summary: "summary",
  details_text: "details-text",
  detailsText: "details-text",
  error: "error",
};

const STRUCTURED_BODY_FIELDS: Record<string, string> = {
  card: "card",
  rich_text: "rich-text",
  richText: "rich-text",
};

const INLINE_FILE_FIELDS: Record<string, string> = {
  content_base64: "base64",
  contentBase64: "base64",
};

const SECRET_BODY_FIELDS: Record<string, string> = {
  token: "token",
  script: "script",
  arguments: "arguments",
  details_json: "details-json",
  detailsJson: "details-json",
};

export function redactHttpRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...body };

  for (const [field, label] of Object.entries(TEXT_BODY_FIELDS)) {
    redactField(redacted, field, label);
  }

  for (const [field, label] of Object.entries(STRUCTURED_BODY_FIELDS)) {
    redactField(redacted, field, label);
  }

  for (const [field, label] of Object.entries(INLINE_FILE_FIELDS)) {
    redactField(redacted, field, label);
  }

  for (const [field, label] of Object.entries(SECRET_BODY_FIELDS)) {
    redactField(redacted, field, label);
  }

  return redacted;
}

function redactField(body: Record<string, unknown>, field: string, label: string): void {
  if (!Object.prototype.hasOwnProperty.call(body, field)) {
    return;
  }

  const value = body[field];
  if (value == null) {
    return;
  }

  body[field] = typeof value === "string" ? `[redacted-${label}:${value.length}]` : `[redacted-${label}]`;
}
