/* 音频解锁核心模块 —— 纯浏览器本地解密，文件不上传。
 * 算法移植自开源项目 unlock-music（Go CLI），并以其公开测试向量验证：
 *   - 酷狗 KGM/KGMA/VPR：crypto v2（掩码表）与 v3（MD5 派生，无大小限制）
 *   - 酷狗 KGG（crypto v5）：需用户提供酷狗 PC 客户端的 KGG 数据库文件
 *   - QQ 音乐 QMC 家族：QMCv1（静态掩码）/ QMCv2（Map / RC4，ekey TEA 派生）
 *   - 网易云 NCM：AES-ECB 密钥 + keyBox 流
 * 仅供转换个人合法获取的文件，请勿传播解密结果。 */
"use strict";

/* ================= 基础工具 ================= */

function bytesEqual(a, b, len = 16) {
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 紧凑 MD5 实现（crypto.subtle 不提供 MD5；仅用于密钥派生，非安全场景） */
function md5(bytes) {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;
  let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
  const len = bytes.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bitLen = len * 8;
  new DataView(withPad.buffer).setUint32(withPad.length - 8, bitLen >>> 0, true);
  new DataView(withPad.buffer).setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);
  const w = new Int32Array(16);
  const dv = new DataView(withPad.buffer);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c; c = b;
      const x = (a + f + K[i] + w[g]) | 0;
      b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0 >>> 0, true); odv.setUint32(4, b0 >>> 0, true);
  odv.setUint32(8, c0 >>> 0, true); odv.setUint32(12, d0 >>> 0, true);
  return out;
}

/** AES-单块 ECB 加密：借道 subtle 的 CBC（IV=0 时单块加密输出前 16 字节即 ECB 结果） */
async function aesEcbEncryptBlock(block, key) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
  const enc = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: new Uint8Array(16) }, cryptoKey, block);
  return new Uint8Array(enc, 0, 16);
}

/** AES-ECB 解密（无 padding）。WebCrypto 的 AES-CBC decrypt 会校验 padding，
 * 无法直接借道：这里把 ECB 密文转成一条 CBC 链，并在末尾伪造一个合法 padding 块，
 * 使整串通过校验，再用 P[i] = D(C[i]) ^ C[i-1] 逐块恢复真正的 ECB 输出。 */
async function aesEcbDecryptBlocks(data, key) {
  if (data.length % 16 !== 0 || data.length === 0) throw new Error("AES 数据长度不是 16 的倍数");
  const n = data.length / 16;
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);

  // 尾块 C[n+1] = E(P_pad ^ C[n])，P_pad = 16 个 0x10（合法 PKCS7）
  const lastC = data.subarray((n - 1) * 16);
  const target = new Uint8Array(16).fill(0x10);
  const tail = await aesEcbEncryptBlock(
    Uint8Array.from(target, (b, i) => b ^ lastC[i]), key);

  const seq = new Uint8Array(data.length + 16);
  seq.set(data);
  seq.set(tail, data.length);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, cryptoKey, seq));

  const out = new Uint8Array(data.length);
  out.set(plain.subarray(0, 16), 0); // IV=0：P[1] = D(C[1]) 即 ECB 输出
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < 16; j++) {
      out[i * 16 + j] = plain[i * 16 + j] ^ data[(i - 1) * 16 + j];
    }
  }
  return out;
}
async function aesEcbEncryptBlocks(data, key) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
  const out = new Uint8Array(data.length);
  const zeroIv = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    const enc = await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: zeroIv }, cryptoKey, data.slice(off, off + 16));
    out.set(new Uint8Array(enc, 0, 16), off);
  }
  return out;
}
function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 16) throw new Error("PKCS7 填充无效");
  return buf.slice(0, buf.length - pad);
}

/** Tencent TEA（32 轮，CBC 变体）解密，忠实移植自 unlock-music key_derive.go */
/** Go x/crypto/tea：rounds=32 → 循环 rounds/2=16 次，每次含 v1/v0 两步；块与 key 全 BigEndian。
 *  所有算术显式 >>>0 归一化，严格对应 Go 的 uint32 语义。 */
function teaDecryptBlock(v0, v1, k) {
  const delta = 0x9e3779b9;
  let sum = Math.imul(delta, 16) >>> 0;
  const [k0, k1, k2, k3] = k;
  for (let i = 0; i < 16; i++) {
    v1 = (v1 - (((((v0 << 4) >>> 0) + k2) % 4294967296) ^ ((v0 + sum) % 4294967296) ^ ((((v0 >>> 5) + k3) % 4294967296)))) >>> 0;
    v0 = (v0 - (((((v1 << 4) >>> 0) + k0) % 4294967296) ^ ((v1 + sum) % 4294967296) ^ ((((v1 >>> 5) + k1) % 4294967296)))) >>> 0;
    sum = (sum - delta) >>> 0;
  }
  return [v0, v1];
}
function teaEncryptBlock(v0, v1, k) {
  const delta = 0x9e3779b9;
  let sum = 0;
  const [k0, k1, k2, k3] = k;
  for (let i = 0; i < 16; i++) {
    sum = (sum + delta) >>> 0;
    v0 = (v0 + (((((v1 << 4) >>> 0) + k0) % 4294967296) ^ ((v1 + sum) % 4294967296) ^ ((((v1 >>> 5) + k1) % 4294967296)))) >>> 0;
    v1 = (v1 + (((((v0 << 4) >>> 0) + k2) % 4294967296) ^ ((v0 + sum) % 4294967296) ^ ((((v0 >>> 5) + k3) % 4294967296)))) >>> 0;
  }
  return [v0, v1];
}

function simpleMakeKey(salt, length) {
  const keyBuf = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    keyBuf[i] = Math.floor(Math.abs(Math.tan(salt + i * 0.1)) * 100.0) & 0xff;
  }
  return keyBuf;
}

/** Tencent TEA CBC 解密（含 salt/zero 校验）。TEA 块按 BigEndian 组装（与 Go x/crypto/tea 一致） */
function decryptTencentTea(inBuf, key) {
  if (inBuf.length % 8 !== 0) throw new Error("TEA 输入长度不是 8 的倍数");
  if (inBuf.length < 16) throw new Error("TEA 输入太短");
  const k = [0, 1, 2, 3].map((i) =>
    ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0);
  const beU32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const bePut = (b, o, v) => {
    b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff;
    b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff;
  };
  const destBuf = new Uint8Array(8);
  {
    // 第一块：destBuf = TEADec(inBuf[0..8])
    const [v0, v1] = teaDecryptBlock(beU32(inBuf, 0), beU32(inBuf, 4), k);
    bePut(destBuf, 0, v0);
    bePut(destBuf, 4, v1);
  }
  const padLen = destBuf[0] & 0x7;
  const outLen = inBuf.length - 1 - padLen - 2 - 7;
  if (outLen < 0) throw new Error("TEA 填充异常");
  const out = new Uint8Array(outLen);

  // 逐块：dest = TEADec(dest ^ curBlock)；ivPrev = curBlock（Go 语义）
  // Go：ivPrev 初始为全 0（第一块解密结果直接透传），ivCur 初始为第一块
  let ivPrev = new Uint8Array(8);
  let ivCur = inBuf.subarray(0, 8);
  let inBufPos = 8;
  let destIdx = 1 + padLen;
  const cryptBlock = () => {
    ivPrev = ivCur; // Go 语义：先取旧 ivCur（第一轮即第一块 inBuf[0:8]）作为 ivPrev
    ivCur = inBuf.subarray(inBufPos, inBufPos + 8);
    const x = new Uint8Array(8);
    for (let i = 0; i < 8; i++) x[i] = destBuf[i] ^ ivCur[i];
    const [v0, v1] = teaDecryptBlock(beU32(x, 0), beU32(x, 4), k);
    bePut(destBuf, 0, v0);
    bePut(destBuf, 4, v1);
    inBufPos += 8;
    destIdx = 0;
  };
  for (let i = 1; i <= 2;) {
    if (destIdx < 8) { destIdx++; i++; }
    else if (destIdx === 8) cryptBlock();
  }
  let outPos = 0;
  while (outPos < outLen) {
    if (destIdx < 8) {
      out[outPos] = destBuf[destIdx] ^ ivPrev[destIdx];
      destIdx++; outPos++;
    } else if (destIdx === 8) cryptBlock();
  }
  for (let i = 1; i <= 7; i++) {
    if (destBuf[destIdx] !== ivPrev[destIdx]) throw new Error("TEA zero 校验失败");
  }
  return out;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Decode(s) {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  const out = [];
  let bits = 0, acc = 0;
  for (const ch of clean) {
    if (ch === "=") break;
    acc = (acc << 6) | BASE64_CHARS.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/* ================= 酷狗 KGM / VPR / KGG ================= */

const KGM_MAGIC = [0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b,
  0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14];
const VPR_MAGIC = [0x05, 0x28, 0xbc, 0x96, 0xe9, 0xe4, 0x5a, 0x43,
  0x91, 0xaa, 0xbd, 0xd0, 0x7a, 0xf5, 0x36, 0x31];

const KGM_MASK_PREDEF = new Uint8Array([
  0xb8, 0xd5, 0x3d, 0xb2, 0xe9, 0xaf, 0x78, 0x8c, 0x83, 0x33, 0x71, 0x51, 0x76, 0xa0, 0xcd, 0x37,
  0x2f, 0x3e, 0x35, 0x8d, 0xa9, 0xbe, 0x98, 0xb7, 0xe7, 0x8c, 0x22, 0xce, 0x5a, 0x61, 0xdf, 0x68,
  0x69, 0x89, 0xfe, 0xa5, 0xb6, 0xde, 0xa9, 0x77, 0xfc, 0xc8, 0xbd, 0xbd, 0xe5, 0x6d, 0x3e, 0x5a,
  0x36, 0xef, 0x69, 0x4e, 0xbe, 0xe1, 0xe9, 0x66, 0x1c, 0xf3, 0xd9, 0x02, 0xb6, 0xf2, 0x12, 0x9b,
  0x44, 0xd0, 0x6f, 0xb9, 0x35, 0x89, 0xb6, 0x46, 0x6d, 0x73, 0x82, 0x06, 0x69, 0xc1, 0xed, 0xd7,
  0x85, 0xc2, 0x30, 0xdf, 0xa2, 0x62, 0xbe, 0x79, 0x2d, 0x62, 0x62, 0x3d, 0x0d, 0x7e, 0xbe, 0x48,
  0x89, 0x23, 0x02, 0xa0, 0xe4, 0xd5, 0x75, 0x51, 0x32, 0x02, 0x53, 0xfd, 0x16, 0x3a, 0x21, 0x3b,
  0x16, 0x0f, 0xc3, 0xb2, 0xbb, 0xb3, 0xe2, 0xba, 0x3a, 0x3d, 0x13, 0xec, 0xf6, 0x01, 0x45, 0x84,
  0xa5, 0x70, 0x0f, 0x93, 0x49, 0x0c, 0x64, 0xcd, 0x31, 0xd5, 0xcc, 0x4c, 0x07, 0x01, 0x9e, 0x00,
  0x1a, 0x23, 0x90, 0xbf, 0x88, 0x1e, 0x3b, 0xab, 0xa6, 0x3e, 0xc4, 0x73, 0x47, 0x10, 0x7e, 0x3b,
  0x5e, 0xbc, 0xe3, 0x00, 0x84, 0xff, 0x09, 0xd4, 0xe0, 0x89, 0x0f, 0x5b, 0x58, 0x70, 0x4f, 0xfb,
  0x65, 0xd8, 0x5c, 0x53, 0x1b, 0xd3, 0xc8, 0xc6, 0xbf, 0xef, 0x98, 0xb0, 0x50, 0x4f, 0x0f, 0xea,
  0xe5, 0x83, 0x58, 0x8c, 0x28, 0x2c, 0x84, 0x67, 0xcd, 0xd0, 0x9e, 0x47, 0xdb, 0x27, 0x50, 0xca,
  0xf4, 0x63, 0x63, 0xe8, 0x97, 0x7f, 0x1b, 0x4b, 0x0c, 0xc2, 0xc1, 0x21, 0x4c, 0xcc, 0x58, 0xf5,
  0x94, 0x52, 0xa3, 0xf3, 0xd3, 0xe0, 0x68, 0xf4, 0x00, 0x23, 0xf3, 0x5e, 0x0a, 0x7b, 0x93, 0xdd,
  0xab, 0x12, 0xb2, 0x13, 0xe8, 0x84, 0xd7, 0xa7, 0x9f, 0x0f, 0x32, 0x4c, 0x55, 0x1d, 0x04, 0x36,
  0x52, 0xdc, 0x03, 0xf3, 0xf9, 0x4e, 0x42, 0xe9, 0x3d, 0x61, 0xef, 0x7c, 0xb6, 0xb3, 0x93, 0x50,
]);
const KGM_MASK_VPR = new Uint8Array([
  0x25, 0xdf, 0xe8, 0xa6, 0x75, 0x1e, 0x75, 0x0e,
  0x2f, 0x80, 0xf3, 0x2d, 0xb8, 0xb6, 0xe3, 0x11, 0x00,
]);
const KGM_MASK_URL = "kgm-v2-mask.bin";
const KGM_MAX_AUDIO_V2 = 6.5 * 1024 * 1024 * 16; // 掩码表覆盖上限（约 104MB）

let kgmMaskPromise = null;
function loadKgmMask() {
  kgmMaskPromise ??= (async () => {
    const res = await fetch(KGM_MASK_URL);
    if (!res.ok) throw new Error("解密表加载失败（" + res.status + "）");
    const ds = res.body.pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  })();
  kgmMaskPromise.catch(() => { kgmMaskPromise = null; });
  return kgmMaskPromise;
}

/** KGM crypto v3：MD5 派生，算法级生成，无大小限制 */
const KGM_V3_SLOT_KEYS = { 1: new Uint8Array([0x6c, 0x2c, 0x2f, 0x27]) };
function kugouMd5(b) {
  const digest = md5(b);
  const ret = new Uint8Array(16);
  for (let i = 0; i < 16; i += 2) {
    ret[i] = digest[14 - i];
    ret[i + 1] = digest[14 - i + 1];
  }
  return ret;
}
function kgmV3Cipher(cryptoKey, cryptoSlot) {
  const slotKey = KGM_V3_SLOT_KEYS[cryptoSlot];
  if (!slotKey) throw new Error("kgm v3: 未知 crypto slot " + cryptoSlot);
  const slotBox = kugouMd5(slotKey);
  const fileBox = new Uint8Array(17);
  fileBox.set(kugouMd5(cryptoKey));
  fileBox[16] = 0x6b;
  return (buf, offset) => {
    for (let i = 0; i < buf.length; i++) {
      const o = offset + i;
      let b = buf[i];
      b ^= fileBox[o % 17];
      b ^= (b << 4) & 0xff;
      b ^= slotBox[o % 16];
      b ^= (o ^ (o >>> 8) ^ (o >>> 16) ^ (o >>> 24)) & 0xff;
      buf[i] = b;
    }
  };
}

/** 解析 KGM/KGG 头并分派到 v2 / v3 / v5(KGG) */
async function decryptKgmFamily(bytes, ext, getDbMapping, onStatus) {
  if (bytes.length < 0x40) throw new Error("文件太小，可能未下载完整");
  let isVpr;
  if (bytesEqual(bytes, KGM_MAGIC)) isVpr = false;
  else if (bytesEqual(bytes, VPR_MAGIC)) isVpr = true;
  else throw new Error("不是 KGM/KGMA/VPR/KGG 文件（文件头不匹配）");

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const audioOffset = dv.getUint32(0x10, true);
  const cryptoVersion = dv.getUint32(0x14, true);
  const cryptoSlot = dv.getUint32(0x18, true);
  const cryptoKey = bytes.slice(0x2c, 0x3c);
  if (audioOffset < 0x40 || audioOffset > bytes.length) throw new Error("文件头长度异常");

  let decryptFn, needDb = false, audioHash = "";
  if (cryptoVersion === 2) {
    // 旧掩码表算法
    const key = new Uint8Array(17);
    key.set(bytes.subarray(0x1c, 0x2c));
    const audio = bytes.slice(audioOffset);
    if (audio.length > KGM_MAX_AUDIO_V2) {
      throw new Error("该文件是 KGM 旧版加密（v2），掩码表限制最大约 104MB；如需更大请用最新酷狗客户端重新下载（新版无此限制）");
    }
    onStatus("加载解密表…");
    const maskLarge = await loadKgmMask();
    decryptFn = (buf, offset) => {
      for (let i = 0; i < buf.length; i++) {
        let v = buf[i] ^ key[i % 17] ^ KGM_MASK_PREDEF[(offset + i) % 272] ^ maskLarge[(offset + i) >> 4];
        v ^= (v & 0x0f) << 4;
        if (isVpr) v ^= KGM_MASK_VPR[(offset + i) % 17];
        buf[i] = v;
      }
    };
    return runStreamDecrypt(audio, decryptFn);
  }
  if (cryptoVersion === 3) {
    decryptFn = kgmV3Cipher(cryptoKey, cryptoSlot);
    return runStreamDecrypt(bytes.subarray(audioOffset), decryptFn);
  }
  if (cryptoVersion === 5) {
    needDb = true;
    // 8 字节跳过 + audioHashLen + audioHash
    let pos = 0x3c + 8;
    const hashLen = dv.getUint32(pos, true); pos += 4;
    audioHash = new TextDecoder().decode(bytes.subarray(pos, pos + hashLen));
    if (!getDbMapping) throw new Error("KGG（v5）需要酷狗 PC 客户端的密钥数据库（db 文件）。请先在下方上传从本机酷狗目录提取的 db 文件。audio_hash=" + audioHash);
    onStatus("在数据库中查找密钥…");
    const mapping = await getDbMapping();
    const ekey = mapping.get(audioHash);
    if (!ekey) throw new Error("数据库中没有该文件的密钥（audio_hash=" + audioHash + "）。请确认 db 来自下载该音乐的同一酷狗账号/设备");
    onStatus("派生密钥…");
    const key = await qmcDeriveKey(new TextEncoder().encode(ekey));
    return runQmcCipher(bytes.subarray(audioOffset), key);
  }
  throw new Error("不支持的 KGM 加密版本 " + cryptoVersion + "（支持 v2/v3；v5=KGG 需要数据库）");
}

/* ================= QQ 音乐 QMC 家族 ================= */

const QMC_STATIC_BOX = new Uint8Array([
  0x77, 0x48, 0x32, 0x73, 0xDE, 0xF2, 0xC0, 0xC8, 0x95, 0xEC, 0x30, 0xB2, 0x51, 0xC3, 0xE1, 0xA0,
  0x9E, 0xE6, 0x9D, 0xCF, 0xFA, 0x7F, 0x14, 0xD1, 0xCE, 0xB8, 0xDC, 0xC3, 0x4A, 0x67, 0x93, 0xD6,
  0x28, 0xC2, 0x91, 0x70, 0xCA, 0x8D, 0xA2, 0xA4, 0xF0, 0x08, 0x61, 0x90, 0x7E, 0x6F, 0xA2, 0xE0,
  0xEB, 0xAE, 0x3E, 0xB6, 0x67, 0xC7, 0x92, 0xF4, 0x91, 0xB5, 0xF6, 0x6C, 0x5E, 0x84, 0x40, 0xF7,
  0xF3, 0x1B, 0x02, 0x7F, 0xD5, 0xAB, 0x41, 0x89, 0x28, 0xF4, 0x25, 0xCC, 0x52, 0x11, 0xAD, 0x43,
  0x68, 0xA6, 0x41, 0x8B, 0x84, 0xB5, 0xFF, 0x2C, 0x92, 0x4A, 0x26, 0xD8, 0x47, 0x6A, 0x7C, 0x95,
  0x61, 0xCC, 0xE6, 0xCB, 0xBB, 0x3F, 0x47, 0x58, 0x89, 0x75, 0xC3, 0x75, 0xA1, 0xD9, 0xAF, 0xCC,
  0x08, 0x73, 0x17, 0xDC, 0xAA, 0x9A, 0xA2, 0x16, 0x41, 0xD8, 0xA2, 0x06, 0xC6, 0x8B, 0xFC, 0x66,
  0x34, 0x9F, 0xCF, 0x18, 0x23, 0xA0, 0x0A, 0x74, 0xE7, 0x2B, 0x27, 0x70, 0x92, 0xE9, 0xAF, 0x37,
  0xE6, 0x8C, 0xA7, 0xBC, 0x62, 0x65, 0x9C, 0xC2, 0x08, 0xC9, 0x88, 0xB3, 0xF3, 0x43, 0xAC, 0x74,
  0x2C, 0x0F, 0xD4, 0xAF, 0xA1, 0xC3, 0x01, 0x64, 0x95, 0x4E, 0x48, 0x9F, 0xF4, 0x35, 0x78, 0x95,
  0x7A, 0x39, 0xD6, 0x6A, 0xA0, 0x6D, 0x40, 0xE8, 0x4F, 0xA8, 0xEF, 0x11, 0x1D, 0xF3, 0x1B, 0x3F,
  0x3F, 0x07, 0xDD, 0x6F, 0x5B, 0x19, 0x30, 0x19, 0xFB, 0xEF, 0x0E, 0x37, 0xF0, 0x0E, 0xCD, 0x16,
  0x49, 0xFE, 0x53, 0x47, 0x13, 0x1A, 0xBD, 0xA4, 0xF1, 0x40, 0x19, 0x60, 0x0E, 0xED, 0x68, 0x09,
  0x06, 0x5F, 0x4D, 0xCF, 0x3D, 0x1A, 0xFE, 0x20, 0x77, 0xE4, 0xD9, 0xDA, 0xF9, 0xA4, 0x2B, 0x76,
  0x1C, 0x71, 0xDB, 0x00, 0xBC, 0xFD, 0x0C, 0x6C, 0xA5, 0x47, 0xF7, 0xF6, 0x00, 0x79, 0x4A, 0x11,
]);

function qmcStaticCipher(buf, offset) {
  for (let i = 0; i < buf.length; i++) {
    let o = offset + i;
    if (o > 0x7fff) o %= 0x7fff;
    buf[i] ^= QMC_STATIC_BOX[(o * o + 27) & 0xff];
  }
}

function qmcMapCipher(key) {
  const size = key.length;
  return (buf, offset) => {
    for (let i = 0; i < buf.length; i++) {
      let o = offset + i;
      if (o > 0x7fff) o %= 0x7fff;
      const idx = (o * o + 71214) % size;
      const rot = ((idx & 0x7) + 4) % 8;
      const v = key[idx];
      // Go byte 语义：left 先截断到 8 位，再与 right 按位或
      buf[i] ^= (((v << rot) & 0xff) | (v >>> rot)) & 0xff;
    }
  };
}

const RC4_SEGMENT = 5120;
const RC4_FIRST_SEGMENT = 128;

function qmcRc4Cipher(key) {
  const n = key.length;
  const box = new Uint8Array(n);
  for (let i = 0; i < n; i++) box[i] = i & 0xff;
  let j = 0;
  for (let i = 0; i < n; i++) {
    j = (j + box[i] + key[i % n]) % n;
    [box[i], box[j]] = [box[j], box[i]];
  }
  let hash = 1;
  for (let i = 0; i < n; i++) {
    const v = key[i];
    if (v === 0) continue;
    const next = Math.imul(hash, v) >>> 0;
    if (next === 0 || next <= hash) break;
    hash = next;
  }
  const segmentSkip = (id) => {
    const seed = key[id % n];
    const idx = Math.trunc((hash / ((id + 1) * seed)) * 100.0);
    return idx % n;
  };
  const encFirstSegment = (buf, offset) => {
    for (let i = 0; i < buf.length; i++) {
      buf[i] ^= key[segmentSkip(offset + i)];
    }
  };
  const encASegment = (buf, offset) => {
    const local = box.slice();
    let jj = 0, kk = 0;
    const skipLen = (offset % RC4_SEGMENT) + segmentSkip(Math.floor(offset / RC4_SEGMENT));
    for (let i = -skipLen; i < buf.length; i++) {
      jj = (jj + 1) % n;
      kk = (local[jj] + kk) % n;
      [local[jj], local[kk]] = [local[kk], local[jj]];
      if (i >= 0) buf[i] ^= local[(local[jj] + local[kk]) % n];
    }
  };
  return (buf, offset) => {
    // 整段处理：offset 从 0 开始按 Go Decrypt 的顺序推进
    let toProcess = buf.length, processed = 0, pos = offset;
    if (pos < RC4_FIRST_SEGMENT) {
      const blockSize = Math.min(toProcess, RC4_FIRST_SEGMENT - pos);
      encFirstSegment(buf.subarray(0, blockSize), pos);
      toProcess -= blockSize; processed += blockSize; pos += blockSize;
    }
    if (toProcess <= 0) return;
    if (pos % RC4_SEGMENT !== 0) {
      const blockSize = Math.min(toProcess, RC4_SEGMENT - (pos % RC4_SEGMENT));
      encASegment(buf.subarray(processed, processed + blockSize), pos);
      toProcess -= blockSize; processed += blockSize; pos += blockSize;
    }
    while (toProcess > RC4_SEGMENT) {
      encASegment(buf.subarray(processed, processed + RC4_SEGMENT), pos);
      toProcess -= RC4_SEGMENT; processed += RC4_SEGMENT; pos += RC4_SEGMENT;
    }
    if (toProcess > 0) encASegment(buf.subarray(processed), pos);
  };
}

function qmcDeriveKeyV1(rawKeyDec) {
  if (rawKeyDec.length < 16) throw new Error("ekey 太短");
  const simpleKey = simpleMakeKey(106, 8);
  const teaKey = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    teaKey[i * 2] = simpleKey[i];
    teaKey[i * 2 + 1] = rawKeyDec[i];
  }
  const rs = decryptTencentTea(rawKeyDec.slice(8), teaKey);
  const out = new Uint8Array(8 + rs.length);
  out.set(rawKeyDec.slice(0, 8));
  out.set(rs, 8);
  return out;
}

const QMC_RAW_KEY_PREFIX_V2 = "QQMusic EncV2,Key:";
const QMC_DERIVE_V2_KEY1 = new Uint8Array([
  0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40,
  0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28]);
const QMC_DERIVE_V2_KEY2 = new Uint8Array([
  0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25,
  0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54]);

async function qmcDeriveKey(rawKey) {
  let rawKeyDec = base64Decode(new TextDecoder().decode(rawKey));
  const prefix = new TextEncoder().encode(QMC_RAW_KEY_PREFIX_V2);
  if (rawKeyDec.length >= prefix.length &&
      prefix.every((b, i) => rawKeyDec[i] === b)) {
    let buf = rawKeyDec.slice(prefix.length);
    buf = decryptTencentTea(buf, QMC_DERIVE_V2_KEY1);
    buf = decryptTencentTea(buf, QMC_DERIVE_V2_KEY2);
    buf = base64Decode(new TextDecoder().decode(buf));
    rawKeyDec = buf;
  }
  return qmcDeriveKeyV1(rawKeyDec);
}

function runQmcCipher(audio, key) {
  let decryptFn;
  if (key.length > 300) decryptFn = qmcRc4Cipher(key);
  else if (key.length > 0) decryptFn = qmcMapCipher(key);
  else decryptFn = qmcStaticCipher;
  return runStreamDecrypt(audio, decryptFn);
}

/** 解析 QMC 尾部结构找 ekey，然后解密 */
async function decryptQmcFamily(bytes, ext, onStatus) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileSize = bytes.length;
  let key = null, audioLen = fileSize;

  if (fileSize > 8) {
    const suffix = new TextDecoder("latin1").decode(bytes.subarray(fileSize - 4));
    if (suffix === "STag") {
      throw new Error("该文件是 STag 格式，密钥不在文件内（QQ 音乐 Mac 专有），无法离线解密");
    }
    if (suffix === "QTag") {
      const rawMetaLen = dv.getUint32(fileSize - 8, false); // BigEndian
      const audioEnd = fileSize - 8 - rawMetaLen;
      if (audioEnd <= 0) throw new Error("QTag 结构异常");
      audioLen = audioEnd;
      const rawMeta = new TextDecoder("latin1").decode(
        bytes.subarray(audioEnd, audioEnd + rawMetaLen));
      const items = rawMeta.split(",");
      if (items.length !== 3) throw new Error("QTag 元数据异常");
      onStatus("派生密钥…");
      key = await qmcDeriveKey(new TextEncoder().encode(items[0]));
    } else if (suffix === "cex\0") {
      const tagSize = dv.getUint32(fileSize - 16, true);
      if (tagSize >= 0xc0) audioLen = fileSize - tagSize;
      throw new Error("该文件使用 musicex 尾标，密钥不在文件内（QQ 音乐 Mac/新版客户端专有），无法离线解密");
    } else {
      const size = dv.getUint32(fileSize - 4, true);
      if (size > 0 && size <= 0xffff && fileSize > 4 + size) {
        onStatus("派生密钥…");
        let rawKeyData = bytes.subarray(fileSize - 4 - size, fileSize - 4);
        // 去尾部 NUL
        let end = rawKeyData.length;
        while (end > 0 && rawKeyData[end - 1] === 0) end--;
        rawKeyData = rawKeyData.subarray(0, end);
        key = await qmcDeriveKey(rawKeyData);
        audioLen = fileSize - 4 - size;
      }
      // 否则：整文件为音频，静态 cipher
    }
  }

  const audio = bytes.slice(0, audioLen);
  if (key === null) return runQmcCipher(audio, new Uint8Array(0));
  return runQmcCipher(audio, key);
}

/* ================= 网易云 NCM ================= */

const NCM_MAGIC = "CTENFDAM";
const NCM_KEY_CORE = new Uint8Array([
  0x68, 0x7a, 0x48, 0x52, 0x41, 0x6d, 0x73, 0x6f,
  0x35, 0x6b, 0x49, 0x6e, 0x62, 0x61, 0x78, 0x57]);
const NCM_KEY_META = new Uint8Array([
  0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21,
  0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28]);

function ncmBuildKeyBox(key) {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (box[i] + j + key[i % key.length]) & 0xff;
    [box[i], box[j]] = [box[j], box[i]];
  }
  const ret = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const _i = (i + 1) & 0xff;
    const si = box[_i];
    const sj = box[(_i + si) & 0xff];
    ret[i] = box[(si + sj) & 0xff];
  }
  return ret;
}

async function decryptNcm(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  if (magic !== NCM_MAGIC) throw new Error("不是 NCM 文件（文件头不匹配）");
  let pos = 10; // magic 8 + gap 2

  // 1. key
  const keyLen = dv.getUint32(pos, true); pos += 4;
  const keyRaw = bytes.slice(pos, pos + keyLen); pos += keyLen;
  for (let i = 0; i < keyRaw.length; i++) keyRaw[i] ^= 0x64;
  const keyData = pkcs7Unpad(await aesEcbDecryptBlocks(keyRaw, NCM_KEY_CORE)).slice(17);

  // 2. meta
  let meta = null;
  const metaLen = dv.getUint32(pos, true); pos += 4;
  if (metaLen > 0) {
    const metaRaw = bytes.slice(pos, pos + metaLen); pos += metaLen;
    for (let i = 22; i < metaRaw.length; i++) metaRaw[i] ^= 0x63; // 跳过 "163 key(Don't modify):"
    const cipherText = base64Decode(new TextDecoder("latin1").decode(metaRaw.subarray(22)));
    const metaJson = pkcs7Unpad(await aesEcbDecryptBlocks(cipherText, NCM_KEY_META));
    const sep = metaJson.indexOf(0x3a); // ':'
    const jsonText = new TextDecoder().decode(metaJson.subarray(sep + 1));
    try { meta = JSON.parse(jsonText); } catch { meta = null; }
  }
  pos += 4; // CRC32
  pos += 5; // gap

  // 3. cover
  const coverFrameLen = dv.getUint32(pos, true);
  const coverLen = dv.getUint32(pos + 4, true);
  const cover = bytes.slice(pos + 8, pos + 8 + coverLen);
  pos += 8 + coverFrameLen + 4;

  // 4. audio：keyBox XOR 流（流第 i 字节 = ret[i & 0xff]）
  const audio = bytes.slice(pos);
  const box = ncmBuildKeyBox(keyData);
  for (let i = 0; i < audio.length; i++) {
    audio[i] ^= box[i & 0xff];
  }

  const format = meta && meta.format ? String(meta.format) : null;
  return { data: audio, ext: format, meta, cover };
}

/* ================= 酷狗 KGG 数据库（用户上传 db） ================= */

const KGG_PAGE_SIZE = 0x400;
const KGG_SQLITE_HEADER = "SQLite format 3\0";
const KGG_MASTER_KEY = new Uint8Array([
  0x1d, 0x61, 0x31, 0x45, 0xb2, 0x47, 0xbf, 0x7f, 0x3d, 0x18, 0x96, 0x72, 0x14, 0x4f, 0xe4, 0xbf,
  0x00, 0x00, 0x00, 0x00,
  0x73, 0x41, 0x6c, 0x54,
]);

function kggDeriveIvSeed(seed) {
  const left = Math.imul(seed, 0x9ef4) >>> 0;
  const right = Math.imul(Math.floor(seed / 0xce26), 0x7fffff07) >>> 0;
  const value = (left - right) >>> 0;
  if ((value & 0x80000000) === 0) return value;
  return (value + 0x7fffffff) >>> 0;
}
function kggDerivePageIv(page) {
  const iv = new Uint8Array(16);
  let p = (page + 1) >>> 0;
  const dv = new DataView(iv.buffer);
  for (let i = 0; i < 16; i += 4) {
    p = kggDeriveIvSeed(p);
    dv.setUint32(i, p, true);
  }
  return md5(iv);
}
function kggDerivePageKey(page) {
  const master = KGG_MASTER_KEY.slice();
  new DataView(master.buffer).setUint32(0x10, page >>> 0, true);
  return md5(master);
}
/** 无 padding AES-CBC 解密：ECB 逐块 + XOR 前块 */
async function aesCbcDecryptNoPadding(data, key, iv) {
  const dec = await aesEcbDecryptBlocks(data, key);
  const out = new Uint8Array(data.length);
  for (let off = 0; off < data.length; off += 16) {
    for (let i = 0; i < 16; i++) {
      out[off + i] = dec[off + i] ^ (off === 0 ? iv[i] : data[off - 16 + i]);
    }
  }
  return out;
}

async function decryptKggDb(dbBytes) {
  const buf = dbBytes.slice();
  if (bytesEqual(buf, new TextEncoder().encode(KGG_SQLITE_HEADER), 16)) {
    return buf; // 未加密
  }
  if (buf.length % KGG_PAGE_SIZE !== 0 || buf.length === 0) {
    throw new Error("db 文件大小异常（不是 " + KGG_PAGE_SIZE + " 的倍数）");
  }
  const pages = buf.length / KGG_PAGE_SIZE;
  // page 1：备份头部 8 字节，从 0x10 起解密，再还原 SQLite 头
  {
    const page = buf.subarray(0, KGG_PAGE_SIZE);
    const expected = page.slice(0x10, 0x18);
    page.copyWithin(0x10, 0x08, 0x10);
    const dec = await aesCbcDecryptNoPadding(page.slice(0x10), kggDerivePageKey(1), kggDerivePageIv(1));
    page.set(dec, 0x10);
    for (let i = 0; i < 8; i++) {
      if (page[0x10 + i] !== expected[i]) throw new Error("db 解密失败：不是有效的酷狗 KGG 数据库");
    }
    buf.set(new TextEncoder().encode(KGG_SQLITE_HEADER).subarray(0, 16), 0);
  }
  for (let p = 2; p <= pages; p++) {
    const page = buf.subarray((p - 1) * KGG_PAGE_SIZE, p * KGG_PAGE_SIZE);
    const dec = await aesCbcDecryptNoPadding(
      page.slice(), kggDerivePageKey(p), kggDerivePageIv(p));
    page.set(dec);
  }
  return buf;
}

let sqlJsPromise = null;
function loadSqlJs() {
  sqlJsPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js";
    s.onload = () => {
      initSqlJs({
        locateFile: (f) => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/" + f,
      }).then(resolve, reject);
    };
    s.onerror = () => reject(new Error("sql.js 加载失败（需联网）"));
    document.head.appendChild(s);
  });
  sqlJsPromise.catch(() => { sqlJsPromise = null; });
  return sqlJsPromise;
}

/** 解析 KGG db → Map(audioHash → ekey) */
async function parseKggKeyTable(dbBytes) {
  const SQL = await loadSqlJs();
  const decrypted = await decryptKggDb(dbBytes);
  const db = new SQL.Database(decrypted);
  try {
    const map = new Map();
    const stmt = db.prepare(
      "select EncryptionKeyId, EncryptionKey from ShareFileItems where EncryptionKey != '' and EncryptionKey is not null");
    try {
      while (stmt.step()) {
        const row = stmt.get();
        map.set(String(row[0]), String(row[1]));
      }
    } finally {
      stmt.free();
    }
    if (!map.size) throw new Error("db 里没有找到任何密钥（ShareFileItems 为空），请确认是从下载音乐的那台电脑提取的 db");
    return map;
  } finally {
    db.close();
  }
}

/* ================= 通用入口 ================= */

function sniffAudioExt(bytes) {
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "mp3";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3";
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "flac";
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "ogg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "wav";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "m4a";
  if (bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75) return "wma";
  if (bytes[0] === 0x4d && bytes[1] === 0x41 && bytes[2] === 0x43) return "ape";
  return null;
}
const yieldLoop = () => new Promise((r) => setTimeout(r, 0));

async function runStreamDecrypt(audio, decryptFn) {
  const CHUNK = 1024 * 1024;
  for (let start = 0; start < audio.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, audio.length);
    decryptFn(audio.subarray(start, end), start);
    await yieldLoop();
  }
  return audio;
}

/** 统一入口：识别格式 → 解密 → 嗅探真实格式。返回 {data, ext, meta, cover} */
async function decryptAudioFile(file, ext, getDbMapping, onStatus) {
  onStatus("读取文件…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const lowerExt = ext.toLowerCase();

  if (["kgm", "kgma", "vpr", "kgg"].includes(lowerExt) || bytesEqual(bytes, KGM_MAGIC) || bytesEqual(bytes, VPR_MAGIC)) {
    const audio = await decryptKgmFamily(bytes, lowerExt, getDbMapping, onStatus);
    const fmt = sniffAudioExt(audio);
    if (!fmt) throw new Error("解密完成但无法识别音频格式（可能是不支持的变体）");
    return { data: audio, ext: fmt, meta: null, cover: null };
  }
  if (lowerExt === "ncm" || new TextDecoder("latin1").decode(bytes.subarray(0, 8)) === NCM_MAGIC) {
    const r = await decryptNcm(bytes);
    if (!r.ext) {
      const sniffed = sniffAudioExt(r.data);
      if (!sniffed) throw new Error("解密完成但无法识别音频格式");
      r.ext = sniffed;
    }
    return r;
  }
  // 其余按 QMC 家族处理（qmc0/2/3/4/6/8/flac/ogg/tkm/bkc*/mflac*/mgg*/mmp4/666c…）
  const audio = await decryptQmcFamily(bytes, lowerExt, onStatus);
  const fmt = sniffAudioExt(audio);
  if (!fmt) throw new Error("解密完成但无法识别音频格式：密钥可能不匹配（静态掩码仅对部分老文件有效）");
  return { data: audio, ext: fmt, meta: null, cover: null };
}

/** 从原始文件名剥离加密后缀（支持多重后缀与副本编号） */
function stripAudioExtName(name) {
  const m = name.match(
    /^(.*?)((?:\.(?:kgm|kgma|vpr|kgg|qmc0|qmc2|qmc3|qmc4|qmc6|qmc8|qmcflac|qmcogg|qmcmp3|tkm|mflac0|mflac1|mflaca|mflach|mflacl|mflacm|mflac|mgg0|mgg1|mgga|mggh|mggl|mggm|mgg|mmp4|bkcflac|bkcmp3|bkcm4a|bkcwav|bkcape|bkcogg|bkcwma|bkcmp4|666c6163|6d7033|6f6767|6d3461|776wma|7776176|ncm))+)(\s*\(\d+\))?$/i
  );
  if (m && m[1]) return m[1].trim() || "audio";
  return name.replace(/\.[^.]+$/, "").trim() || "audio";
}

/** 从酷狗客户端 db 文件构建 audioHash → ekey 映射（浏览器内完成，不上传） */
async function prepareKggKeys(dbFile) {
  const dbBytes = new Uint8Array(await dbFile.arrayBuffer());
  return parseKggKeyTable(dbBytes);
}

/* ================= 全局导出（由 script.js 按需加载） ================= */
window.AudioDecryptReady = true;
window.AudioDecrypt = {
  decryptAudioFile,
  stripAudioExtName,
  prepareKggKeys,
};
