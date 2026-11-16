/**
 * Connects KmsEcdsaSigner to the AWS SDK v3 KMS client. The SDK is loaded lazily, so the gateway starts
 * without it and a missing SDK fails the review, not the process. The region and key come from config;
 * the credentials come from the approved reviewer role (the default AWS credential chain). The loader is
 * injectable so tests can run without the SDK installed.
 */
import type { KmsSendLike } from './kms-signer';

export type KmsModuleLike = {
  KMSClient: new (cfg: { region: string }) => { send(cmd: unknown): Promise<Record<string, unknown>> };
  SignCommand: new (input: Record<string, unknown>) => unknown;
  GetPublicKeyCommand: new (input: Record<string, unknown>) => unknown;
};

export async function createKmsSend(input: {
  region: string;
  load?: () => Promise<KmsModuleLike>;
}): Promise<KmsSendLike> {
  const mod = input.load
    ? await input.load()
    : ((await import('@aws-sdk/client-kms')) as unknown as KmsModuleLike);
  const client = new mod.KMSClient({ region: input.region });
  return {
    send: async (cmd) => {
      const Ctor = cmd.name === 'SignCommand' ? mod.SignCommand : mod.GetPublicKeyCommand;
      return client.send(new Ctor(cmd.input));
    },
  };
}
