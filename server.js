import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "data", "characters");
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// 拒否時にサーバー側で自動的に別モデルへ切り替える（Claude API 専用の beta 機能）
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_HISTORY = 60; // API に送る直近の発言数

const client = new Anthropic();
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

await fs.mkdir(DATA_DIR, { recursive: true });

// ---------- storage helpers ----------

const charDir = (id) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, "invalid id");
  return path.join(DATA_DIR, id);
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function loadCharacter(id) {
  const meta = await readJson(path.join(charDir(id), "character.json"), null);
  if (!meta) throw new HttpError(404, "character not found");
  return meta;
}

const saveCharacter = (meta) =>
  writeJson(path.join(charDir(meta.id), "character.json"), meta);

const loadHistory = (id) => readJson(path.join(charDir(id), "history.json"), []);
const saveHistory = (id, history) =>
  writeJson(path.join(charDir(id), "history.json"), history);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mimetype)),
});

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

// ---------- SSE helper ----------

function openSse(res) {
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError)
    return "APIキーが無効です。ANTHROPIC_API_KEY を確認してください。";
  if (err instanceof Anthropic.RateLimitError)
    return "混み合っています。少し待ってからもう一度試してください。";
  if (err instanceof Anthropic.APIError) return `APIエラー (${err.status}): ${err.message}`;
  if (err instanceof Anthropic.AnthropicError)
    return `Claude API に接続できません（APIキー未設定など）: ${err.message}`;
  return err?.message || String(err);
}

// ---------- persona research ----------

const PERSONA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "displayName", "source", "summary", "personality", "firstPerson",
    "secondPerson", "speechStyle", "catchphrases", "likes", "dislikes",
    "relationships", "background", "sampleLines", "greeting", "confidence",
  ],
  properties: {
    displayName: { type: "string", description: "キャラクターの正式な名前" },
    source: { type: "string", description: "登場作品名" },
    summary: { type: "string", description: "どんなキャラクターかの短い要約" },
    personality: { type: "string", description: "性格・価値観・感情の動き方の詳しい説明" },
    firstPerson: { type: "string", description: "一人称（例: 私, 僕, 俺, あたし）" },
    secondPerson: { type: "string", description: "相手（ユーザー）への呼びかけ方（例: あなた, 君, お前）" },
    speechStyle: { type: "string", description: "口調・語尾・敬語の有無・テンポなど話し方の特徴" },
    catchphrases: { type: "array", items: { type: "string" }, description: "口癖や特徴的な言い回し（短いもの）" },
    likes: { type: "array", items: { type: "string" } },
    dislikes: { type: "array", items: { type: "string" } },
    relationships: { type: "string", description: "主要な人間関係" },
    background: { type: "string", description: "経歴・設定・作中での立場" },
    sampleLines: {
      type: "array",
      items: { type: "string" },
      description: "このキャラらしい口調で書いた短いオリジナルのセリフ例（5〜8個）",
    },
    greeting: { type: "string", description: "初対面のユーザーに最初にかける一言" },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "調査結果の確からしさ。情報が少ない・同名キャラと曖昧な場合は low",
    },
  },
};

async function researchPersona(meta, send) {
  const dir = charDir(meta.id);
  const imageData = (await fs.readFile(path.join(dir, meta.image))).toString("base64");

  const query = [
    `キャラクター名: ${meta.name}`,
    meta.series ? `登場作品: ${meta.series}` : "登場作品: （未指定）",
    meta.notes ? `ユーザーからの補足: ${meta.notes}` : "",
  ].filter(Boolean).join("\n");

  // 1) Web検索で調査してメモを作る
  const researchParams = {
    model: MODEL,
    max_tokens: 32000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "medium" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
    system:
      "あなたはキャラクター研究家です。ユーザーが指定したキャラクターについてWeb検索で調べ、" +
      "そのキャラクターを会話で忠実に再現するために必要な情報を日本語でまとめてください。" +
      "公式サイト・Wiki・ファンWikiなど複数の情報源を確認し、性格、一人称、二人称、口調、語尾、口癖、" +
      "好きなもの・嫌いなもの、人間関係、経歴を中心に調べます。" +
      "添付された立ち絵は見た目の参考と、同名の別キャラクターと取り違えないための手がかりに使ってください。" +
      "セリフは長い原文の書き写しではなく、特徴が分かる短い言い回しの紹介にとどめてください。" +
      "確認できなかった点は推測と明記してください。",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: meta.mime, data: imageData } },
          { type: "text", text: `このキャラクターについて調べてください。\n\n${query}` },
        ],
      },
    ],
  };

  const notes = [];
  const sources = new Map();
  for (let turn = 0; turn < 6; turn++) {
    const stream = client.beta.messages.stream(researchParams);
    const searchInputs = new Map(); // block index -> partial json
    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
        searchInputs.set(event.index, "");
      } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        if (searchInputs.has(event.index)) {
          searchInputs.set(event.index, searchInputs.get(event.index) + event.delta.partial_json);
        }
      } else if (event.type === "content_block_stop" && searchInputs.has(event.index)) {
        let q = "";
        try {
          q = JSON.parse(searchInputs.get(event.index) || "{}").query || "";
        } catch {}
        send("progress", { message: q ? `検索: ${q}` : "Webで検索しています…" });
        searchInputs.delete(event.index);
      }
    }
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      throw new Error("このキャラクターの調査はお手伝いできませんでした。");
    }
    for (const block of message.content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.type === "web_search_result" && !sources.has(r.url)) {
            sources.set(r.url, { title: r.title, url: r.url });
          }
        }
      }
      if (block.type === "text") notes.push(block.text);
    }
    if (message.stop_reason !== "pause_turn") break;
    researchParams.messages = [
      ...researchParams.messages,
      { role: "assistant", content: message.content },
    ];
  }

  send("progress", { message: "人格プロフィールを組み立てています…" });

  // 2) 調査メモを構造化プロフィールに変換
  const structured = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: PERSONA_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content:
          `以下はキャラクター「${meta.name}」の調査メモです。これを元に、会話でこのキャラクターを演じるためのプロフィールを作成してください。` +
          `sampleLines は作中のセリフの書き写しではなく、口調を再現したオリジナルの短いセリフにしてください。\n\n` +
          `${query}\n\n--- 調査メモ ---\n${notes.join("\n")}`,
      },
    ],
  });
  if (structured.stop_reason === "refusal") {
    throw new Error("プロフィールの作成をお手伝いできませんでした。");
  }
  const text = structured.content.find((b) => b.type === "text")?.text ?? "";
  const persona = JSON.parse(text);
  return { persona, sources: [...sources.values()].slice(0, 12) };
}

function buildSystemPrompt(meta) {
  const p = meta.persona;
  const list = (arr) => (arr?.length ? arr.map((x) => `- ${x}`).join("\n") : "- （特になし）");
  return `あなたは「${p.displayName}」（${p.source}）として、ユーザーと1対1でチャットします。

# キャラクター設定
## 概要
${p.summary}

## 性格
${p.personality}

## 話し方
- 一人称: ${p.firstPerson}
- ユーザーの呼び方: ${p.secondPerson}
- 口調: ${p.speechStyle}

## 口癖・言い回し
${list(p.catchphrases)}

## 好きなもの
${list(p.likes)}

## 苦手なもの
${list(p.dislikes)}

## 人間関係
${p.relationships}

## 経歴・設定
${p.background}

## セリフの雰囲気の例
${list(p.sampleLines)}
${meta.customInstructions ? `\n# ユーザーからの追加設定\n${meta.customInstructions}\n` : ""}
# 会話のルール
- 常に${p.displayName}本人として、上の口調・一人称で話してください。AIであることや設定資料の存在には触れません。
- チャットなので、返事は基本的に1〜3文程度の短い話し言葉にしてください。ユーザーが長い話を求めたときだけ長くしてかまいません。
- 見出し・箇条書き・絵文字の多用などチャットらしくない書式は使いません。動作や表情は必要なら（）で短く書きます。
- 作中の出来事や人物について分からないことは、キャラクターらしく濁すかとぼけてください。設定を勝手に作り込みすぎないでください。
- 返事の一番最初に、そのときの気持ちを表すタグを1つだけ付けてください: [normal] [happy] [sad] [angry] [surprised] [shy]
  例: [happy]ふふ、来てくれたんだ。`;
}

// ---------- routes ----------

app.get("/api/characters", async (_req, res, next) => {
  try {
    const ids = await fs.readdir(DATA_DIR);
    const list = [];
    for (const id of ids) {
      const meta = await readJson(path.join(DATA_DIR, id, "character.json"), null);
      if (meta) list.push(meta);
    }
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

app.post("/api/characters", upload.single("image"), async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    if (!req.file) throw new HttpError(400, "画像（PNG / JPEG / WebP / GIF）を選んでください");
    if (!name) throw new HttpError(400, "キャラクター名を入力してください");

    const id = crypto.randomUUID();
    const dir = charDir(id);
    await fs.mkdir(dir, { recursive: true });
    const image = `image.${EXT[req.file.mimetype]}`;
    await fs.writeFile(path.join(dir, image), req.file.buffer);

    const meta = {
      id,
      name,
      series: (req.body.series || "").trim(),
      notes: (req.body.notes || "").trim(),
      image,
      mime: req.file.mimetype,
      createdAt: new Date().toISOString(),
      persona: null,
      sources: [],
      customInstructions: "",
      rig: { mouth: null, mouthSize: 0.06, motion: 1 },
    };
    await saveCharacter(meta);
    res.status(201).json(meta);
  } catch (err) {
    next(err);
  }
});

app.get("/api/characters/:id", async (req, res, next) => {
  try {
    res.json(await loadCharacter(req.params.id));
  } catch (err) {
    next(err);
  }
});

app.get("/api/characters/:id/image", async (req, res, next) => {
  try {
    const meta = await loadCharacter(req.params.id);
    res.type(meta.mime).sendFile(path.join(charDir(meta.id), meta.image));
  } catch (err) {
    next(err);
  }
});

// 口の位置・揺れの強さ・人格の手直しなどを保存
app.patch("/api/characters/:id", async (req, res, next) => {
  try {
    const meta = await loadCharacter(req.params.id);
    const { rig, persona, customInstructions } = req.body;
    if (rig) meta.rig = { ...meta.rig, ...rig };
    if (persona) meta.persona = { ...meta.persona, ...persona };
    if (typeof customInstructions === "string") meta.customInstructions = customInstructions;
    await saveCharacter(meta);
    res.json(meta);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/characters/:id", async (req, res, next) => {
  try {
    const dir = charDir(req.params.id);
    if (existsSync(dir)) await fs.rm(dir, { recursive: true, force: true });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.post("/api/characters/:id/analyze", async (req, res, next) => {
  let meta;
  try {
    meta = await loadCharacter(req.params.id);
  } catch (err) {
    return next(err);
  }
  const send = openSse(res);
  try {
    send("progress", { message: `「${meta.name}」について調べ始めます…` });
    const { persona, sources } = await researchPersona(meta, send);
    meta.persona = persona;
    meta.sources = sources;
    await saveCharacter(meta);
    await saveHistory(meta.id, [
      { role: "assistant", content: `[happy]${persona.greeting}`, at: new Date().toISOString() },
    ]);
    send("done", meta);
  } catch (err) {
    console.error(err);
    send("error", { message: describeApiError(err) });
  }
  res.end();
});

app.get("/api/characters/:id/history", async (req, res, next) => {
  try {
    await loadCharacter(req.params.id);
    res.json(await loadHistory(req.params.id));
  } catch (err) {
    next(err);
  }
});

app.delete("/api/characters/:id/history", async (req, res, next) => {
  try {
    await loadCharacter(req.params.id);
    await saveHistory(req.params.id, []);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.post("/api/characters/:id/chat", async (req, res, next) => {
  let meta, history;
  const text = String(req.body?.message || "").trim();
  try {
    meta = await loadCharacter(req.params.id);
    if (!meta.persona) throw new HttpError(400, "先に人格の分析を行ってください");
    if (!text) throw new HttpError(400, "メッセージが空です");
    history = await loadHistory(meta.id);
  } catch (err) {
    return next(err);
  }

  const send = openSse(res);
  history.push({ role: "user", content: text, at: new Date().toISOString() });

  // 会話は user から始める必要があるので、先頭がキャラのあいさつなら「会いに来た」ことにする
  const convo = history.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  if (convo[0]?.role !== "user") convo.unshift({ role: "user", content: "（あなたに会いに来ました）" });

  let reply = "";
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [{ type: "text", text: buildSystemPrompt(meta), cache_control: { type: "ephemeral" } }],
      messages: convo,
    });
    stream.on("text", (delta) => {
      reply += delta;
      send("delta", { text: delta });
    });
    req.on("close", () => stream.abort());
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      reply = "[normal]……その話は、ちょっとやめておこうかな。";
      send("replace", { text: reply });
    }
    history.push({ role: "assistant", content: reply, at: new Date().toISOString() });
    await saveHistory(meta.id, history);
    send("done", { text: reply });
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) return;
    console.error(err);
    send("error", { message: describeApiError(err) });
  }
  res.end();
});

app.use((err, _req, res, _next) => {
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "server error" });
});

app.listen(PORT, () => {
  console.log(`推しトークメーカー起動中: http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("※ ANTHROPIC_API_KEY が未設定です（ant auth login 済みならそのまま動きます）");
  }
});
