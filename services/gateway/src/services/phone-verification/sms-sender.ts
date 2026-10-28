/**
 * VTID-05095: one transactional SMS through AWS End User Messaging SMS
 * (pinpoint-sms-voice-v2 SendTextMessage). Task-role credentials, region
 * eu-central-1 unless AWS_SMS_REGION / AWS_REGION say otherwise. Lazy
 * singleton, same shape as the Polly client (services/tts/polly.ts).
 */

import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
  type SendTextMessageCommandInput,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';

let client: PinpointSMSVoiceV2Client | null = null;

function smsClient(): PinpointSMSVoiceV2Client {
  if (!client) {
    client = new PinpointSMSVoiceV2Client({
      region: process.env.AWS_SMS_REGION || process.env.AWS_REGION || 'eu-central-1',
    });
  }
  return client;
}

export type SmsSender = (phoneE164: string, text: string) => Promise<{ messageId: string | null }>;

export const sendVerificationSms: SmsSender = async (phoneE164, text) => {
  const input: SendTextMessageCommandInput = {
    DestinationPhoneNumber: phoneE164,
    MessageBody: text,
    MessageType: 'TRANSACTIONAL',
  };
  // A registered sender ID or an origination number / pool; unset = the
  // account's default origination for the destination country.
  const origination = process.env.PHONE_VERIFY_ORIGINATION || process.env.PHONE_VERIFY_SENDER_ID;
  if (origination) input.OriginationIdentity = origination;
  if (process.env.PHONE_VERIFY_CONFIGURATION_SET) input.ConfigurationSetName = process.env.PHONE_VERIFY_CONFIGURATION_SET;
  const out = await smsClient().send(new SendTextMessageCommand(input));
  return { messageId: out.MessageId ?? null };
};
