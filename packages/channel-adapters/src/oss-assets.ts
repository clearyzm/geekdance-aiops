import { createHmac } from "node:crypto";

export type OssAssetStoreOptions = {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  accessKeySecret: string;
};

export class OssAssetStore {
  private readonly endpoint: URL;
  private readonly prefix: string;

  constructor(private readonly options: OssAssetStoreOptions) {
    this.endpoint = new URL(options.endpoint);
    this.prefix = options.prefix.replace(/^\/+|\/+$/g, "");
  }

  private objectName(storageKey: string) {
    return this.prefix ? `${this.prefix}/${storageKey}` : storageKey;
  }

  private objectUrl(storageKey: string) {
    const url = new URL(this.endpoint);
    url.hostname = `${this.options.bucket}.${url.hostname}`;
    url.pathname = `/${this.objectName(storageKey)}`;
    return url;
  }

  private signature(value: string) {
    return createHmac("sha1", this.options.accessKeySecret)
      .update(value)
      .digest("base64");
  }

  async put(storageKey: string, bytes: Uint8Array, mimeType: string) {
    const date = new Date().toUTCString();
    const resource = `/${this.options.bucket}/${this.objectName(storageKey)}`;
    const authorization = `OSS ${this.options.accessKeyId}:${this.signature(
      `PUT\n\n${mimeType}\n${date}\n${resource}`,
    )}`;
    const response = await fetch(this.objectUrl(storageKey), {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": mimeType,
        Date: date,
      },
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`OSS_ASSET_UPLOAD_${response.status}`);
  }

  signedUrl(storageKey: string, lifetimeSeconds = 900) {
    const expires = Math.floor(Date.now() / 1000) + lifetimeSeconds;
    const resource = `/${this.options.bucket}/${this.objectName(storageKey)}`;
    const signature = this.signature(`GET\n\n\n${expires}\n${resource}`);
    const url = this.objectUrl(storageKey);
    url.searchParams.set("OSSAccessKeyId", this.options.accessKeyId);
    url.searchParams.set("Expires", String(expires));
    url.searchParams.set("Signature", signature);
    return url.toString();
  }
}

export function createOssAssetStore(
  options: Partial<OssAssetStoreOptions>,
): OssAssetStore | undefined {
  if (
    !options.endpoint ||
    !options.bucket ||
    !options.accessKeyId ||
    !options.accessKeySecret
  )
    return undefined;
  return new OssAssetStore({
    endpoint: options.endpoint,
    bucket: options.bucket,
    prefix: options.prefix ?? "ai-ops",
    accessKeyId: options.accessKeyId,
    accessKeySecret: options.accessKeySecret,
  });
}
