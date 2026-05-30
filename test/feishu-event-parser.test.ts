import { describe, expect, it } from "vitest";

import {
  parseFeishuReceiveMessageEvent,
  routeFeishuReceiveMessageEvent
} from "../src/services/feishu/feishu-event-parser.js";

describe("parseFeishuReceiveMessageEvent", () => {
  it("parses group mentions as bot mention inputs", () => {
    const parsed = parseFeishuReceiveMessageEvent(
      {
        header: {
          event_id: "evt_feishu_1"
        },
        event: {
          sender: {
            sender_id: {
              open_id: "ou_user"
            },
            sender_type: "user"
          },
          message: {
            chat_id: "oc_group",
            chat_type: "group",
            message_id: "om_msg",
            root_id: "",
            parent_id: "",
            create_time: "1710000000000",
            message_type: "text",
            content: JSON.stringify({
              text: "@_user_1 please check this"
            }),
            mentions: [
              {
                key: "@_user_1",
                id: {
                  open_id: "ou_bot"
                },
                name: "Codex"
              }
            ]
          }
        }
      },
      {
        botIdentity: {
          openId: "ou_bot"
        }
      }
    );

    expect(parsed?.route).toBe("bot_mention");
    expect(parsed?.controlText).toBe("please check this");
    expect(parsed?.input).toMatchObject({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_msg",
      messageId: "om_msg",
      eventId: "evt_feishu_1",
      messageCursor: "1710000000000",
      source: "bot_mention",
      text: "@_user_1 please check this",
      mentionedUserIds: ["ou_bot"]
    });
  });

  it("ignores private chats", () => {
    const parsed = parseFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_user"
        },
        sender_type: "user"
      },
      message: {
        chat_id: "oc_private",
        chat_type: "p2p",
        message_id: "om_msg",
        message_type: "text",
        content: JSON.stringify({
          text: "hello"
        })
      }
    });

    expect(parsed).toBeNull();
  });

  it("ignores bot sender messages even when bot identity is unavailable", () => {
    const routed = routeFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_any_bot"
        },
        sender_type: "bot"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_bot",
        message_type: "text",
        content: JSON.stringify({
          text: "bot echo"
        })
      }
    });

    expect(routed).toMatchObject({
      route: "ignored",
      ignoredReason: "ignored_self",
      conversationId: "oc_group",
      conversationKind: "group",
      messageId: "om_bot",
      senderKind: "bot"
    });
  });

  it("ignores user sender messages that match the configured bot identity", () => {
    const routed = routeFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_bot"
        },
        sender_type: "user"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_bot_user",
        message_type: "text",
        content: JSON.stringify({
          text: "self echo"
        })
      }
    }, {
      botIdentity: {
        openId: "ou_bot"
      }
    });

    expect(routed).toMatchObject({
      route: "ignored",
      ignoredReason: "ignored_self",
      conversationId: "oc_group",
      conversationKind: "group",
      messageId: "om_bot_user",
      senderKind: "user"
    });
  });

  it.each([
    ["user_id", { userId: "bot-user-id" }],
    ["union_id", { unionId: "bot-union-id" }]
  ] as const)("ignores user sender messages that match the configured bot %s", (_, botIdentity) => {
    const routed = routeFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_different_sender",
          user_id: "bot-user-id",
          union_id: "bot-union-id"
        },
        sender_type: "user"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_bot_user_alt_identity",
        message_type: "text",
        content: JSON.stringify({
          text: "self echo through alternate identity"
        })
      }
    }, {
      botIdentity
    });

    expect(routed).toMatchObject({
      route: "ignored",
      ignoredReason: "ignored_self",
      conversationId: "oc_group",
      conversationKind: "group",
      messageId: "om_bot_user_alt_identity",
      senderKind: "user"
    });
  });

  it("ignores app sender messages as self messages", () => {
    const routed = routeFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          app_id: "cli-test"
        },
        sender_type: "app"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_app",
        message_type: "text",
        content: JSON.stringify({
          text: "app echo"
        })
      }
    }, {
      botIdentity: {
        appId: "cli-test"
      }
    });

    expect(routed).toMatchObject({
      route: "ignored",
      ignoredReason: "ignored_self",
      conversationId: "oc_group",
      conversationKind: "group",
      messageId: "om_app",
      senderKind: "app"
    });
  });

  it("parses replies as thread reply inputs", () => {
    const parsed = parseFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_user"
        },
        sender_type: "user"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_reply",
        root_id: "om_root",
        parent_id: "om_root",
        thread_id: "omt_thread",
        create_time: "1710000001000",
        message_type: "text",
        content: JSON.stringify({
          text: "follow up"
        })
      }
    });

    expect(parsed?.route).toBe("thread_reply");
    expect(parsed?.input).toMatchObject({
      rootMessageId: "om_root",
      parentMessageId: "om_root",
      platformThreadId: "omt_thread",
      source: "thread_reply"
    });
  });

  it("uses parent_id as the root coordinate when Feishu omits root_id on a reply", () => {
    const parsed = parseFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_user"
        },
        sender_type: "user"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_parent_only_reply",
        parent_id: "om_root",
        thread_id: "omt_thread",
        create_time: "1710000001001",
        message_type: "text",
        content: JSON.stringify({
          text: "follow up without root id"
        })
      }
    });

    expect(parsed?.route).toBe("thread_reply");
    expect(parsed?.input).toMatchObject({
      rootMessageId: "om_root",
      parentMessageId: "om_root",
      platformThreadId: "omt_thread",
      source: "thread_reply"
    });
  });

  it("preserves rich text and cards as structured raw message content", () => {
    const richText = parseFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_user"
        },
        sender_type: "user"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_post",
        message_type: "post",
        content: JSON.stringify({
          title: "Status",
          content: [[{ tag: "text", text: "Build passed" }]]
        })
      }
    });

    expect(richText?.input.format).toBe("rich_text");
    expect(richText?.input.text).toContain("Build passed");
    expect(richText?.input.rawMessage).toEqual(
      expect.objectContaining({
        message_id: "om_post"
      })
    );

    const card = parseFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_user"
        },
        sender_type: "user"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_card",
        message_type: "interactive",
        content: JSON.stringify({
          title: "Deploy"
        })
      }
    });

    expect(card?.input.format).toBe("card");
    expect(card?.input.text).toBe("[Feishu card: Deploy]");
  });

  it("extracts image and file resource keys", () => {
    const image = parseFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_user"
        },
        sender_type: "user"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_image",
        message_type: "image",
        content: JSON.stringify({
          image_key: "img_v2_key"
        })
      }
    });

    expect(image?.input.attachments).toEqual([
      expect.objectContaining({
        platform: "feishu",
        id: "img_v2_key",
        kind: "image",
        messageId: "om_image",
        resourceKey: "img_v2_key"
      })
    ]);

    const file = parseFeishuReceiveMessageEvent({
      sender: {
        sender_id: {
          open_id: "ou_user"
        },
        sender_type: "user"
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_file",
        message_type: "file",
        content: JSON.stringify({
          file_key: "file_v2_key",
          file_name: "report.pdf"
        })
      }
    });

    expect(file?.input.attachments).toEqual([
      expect.objectContaining({
        id: "file_v2_key",
        kind: "file",
        name: "report.pdf"
      })
    ]);
  });
});
