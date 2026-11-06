/**
 * HCS topic for task, feed, and receipt messages. The operator key is the only submit key.
 * No admin key, so the topic cannot be edited or deleted.
 *   npm run topic
 */
import { TopicCreateTransaction } from "@hiero-ledger/sdk";
import { networkSlug, operatorClient, writeEnv } from "./lib";

const client = operatorClient();
const tx = await new TopicCreateTransaction()
  .setTopicMemo("Byline Work task log v3")
  .setSubmitKey(client.operatorPublicKey!)
  .execute(client);
const receipt = await tx.getReceipt(client);
const id = receipt.topicId?.toString();
if (!id) throw new Error("topic create returned no topic id");
writeEnv({ HCS_TOPIC_ID: id });
console.log(`HCS_TOPIC_ID=${id}`);
console.log(`# https://hashscan.io/${networkSlug()}/topic/${id}`);
client.close();
