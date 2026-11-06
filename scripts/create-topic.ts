/**
 * HCS topic for task, feed, and receipt messages. The operator key is the only submit key.
 * No admin key, so the topic cannot be edited or deleted.
 *   npm run topic
 */
import { TopicCreateTransaction } from "@hiero-ledger/sdk";
import { operatorClient } from "./lib";

const client = operatorClient();
const tx = await new TopicCreateTransaction()
  .setTopicMemo("Byline Work task log v3")
  .setSubmitKey(client.operatorPublicKey!)
  .execute(client);
const receipt = await tx.getReceipt(client);
const id = receipt.topicId!.toString();
console.log(`HCS_TOPIC_ID=${id}`);
console.log(`# https://hashscan.io/testnet/topic/${id}`);
console.log(`# mirror: https://testnet.mirrornode.hedera.com/api/v1/topics/${id}/messages`);
client.close();
