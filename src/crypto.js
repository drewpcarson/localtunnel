const crypto = require("node:crypto");

const ITERATIONS = 210000;
const KEY_LENGTH = 32;
const DIGEST = "sha512";
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

function deriveKey(sharedKey, salt) {
  return crypto.pbkdf2Sync(sharedKey, salt, ITERATIONS, KEY_LENGTH, DIGEST);
}

function encryptBuffer(buffer, sharedKey) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(sharedKey, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptBuffer(payload, sharedKey) {
  const iv = Buffer.from(payload.iv, "base64");
  const salt = Buffer.from(payload.salt, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const data = Buffer.from(payload.data, "base64");
  const key = deriveKey(sharedKey, salt);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function keyFingerprint(sharedKey) {
  return crypto.createHash("sha256").update(sharedKey).digest("hex");
}

module.exports = {
  decryptBuffer,
  encryptBuffer,
  keyFingerprint,
};
