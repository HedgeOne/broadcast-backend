import type { Message } from "../../db/schema/index.js";
import { notificationJobs } from "../../db/schema/index.js";
import type { Tx } from "../chats/chat-tx.js";

// Records that a message needs a push. Must run in the transaction that
// inserts the message: the job becomes visible to workers only if the
// message commits. System events don't notify.
export async function enqueueMessageNotification(
  tx: Tx,
  message: Pick<Message, "id" | "chatId" | "type">,
): Promise<void> {
  if (message.type === "system") return;
  await tx
    .insert(notificationJobs)
    .values({ messageId: message.id, chatId: message.chatId })
    .onConflictDoNothing();
}
