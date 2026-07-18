/* ============================================================
   婚活自己開示QA Part3 – app.js
   ------------------------------------------------------------
   共有リンクは「id（短いランダムID）＋復号鍵（URLのフラグメント）」
   のみで構成される。回答本体は暗号化されたうえで GAS 経由で
   スプレッドシートに保存され、復号鍵はサーバーに送信されない
   （URLの # 以降はブラウザからサーバーへ送信されないため）。
   ============================================================ */

const LIFF_ID   = "2010671859-Cfdh3l1P";
const DRAFT_KEY = "konkatsu_qa_part3_draft_v2";

// ▼▼▼ デプロイ済みGAS Web AppのURL ▼▼▼
const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbyP0doHt4EODuHGMTHbTIEFiDxuuMKVeNN67hgrlg67ZezcZr3Elb0h6zGmaz4tytee/exec";

/* ============================================================
   Base64URL 変換ユーティリティ（AES鍵・暗号文の符号化に使用）
   ============================================================ */
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlToBuf(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad    = padded.length % 4;
  const fixed  = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(fixed);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ============================================================
   SHA-256ハッシュ（LINE UserIDのハッシュ化。生IDはサーバーに送らない）
   ============================================================ */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   AES-GCM 暗号化ユーティリティ
   鍵はURLのフラグメント（#以降）にのみ含め、サーバーには渡さない。
   ============================================================ */
async function generateShareKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return { key, base64: bufToBase64Url(raw) };
}

async function importShareKey(base64) {
  const raw = base64UrlToBuf(base64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function encryptJSON(obj, key) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return bufToBase64Url(combined.buffer);
}

async function decryptJSON(base64, key) {
  const combined = new Uint8Array(base64UrlToBuf(base64));
  const iv   = combined.slice(0, 12);
  const data = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/* ------------------------------------------------------------
   LINEユーザーIDの取得
   liff.getProfile() はLINEサーバーへの追加API呼び出しが必要で、
   ログイン直後などタイミングによって不安定になりやすい。
   ログイン時に発行されるIDトークンをその場でデコードするだけなら
   通信が発生せず、ユーザーID（sub）を安定して取得できる。
   表示名・プロフィール画像は使わない設計なので、これで十分。
   ------------------------------------------------------------ */
function getLineUserId() {
  const idToken = liff.getDecodedIDToken();
  if (!idToken || !idToken.sub) {
    throw new Error("ID token is not available (sub claim missing)");
  }
  return idToken.sub;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------
   ランキング選択肢一覧（共有URL短縮のため、テキストの代わりに
   インデックス番号でやり取りする）
   ------------------------------------------------------------ */
const Q4_OPTIONS = [
  "水土日の週休3日制",
  "金土日の週休3日制",
  "休みは変わらず1日の労働時間が5～6時間になる",
  "大型連休の回数が増える",
  "まるまる1ヶ月GWになる",
];

const Q6_OPTIONS = [
  "老若男女問わず褒められる",
  "食事や運動に気をつけなくても維持できる理想的な体型",
  "地頭の良さ",
  "運動神経",
  "お金を稼ぐ能力の高さ",
  "誰とでもすぐ打ち解けられ好かれるコミュニケーション能力",
  "アルコールへの耐性",
  "体力",
  "何があっても落ち込まないメンタルの強さ",
];

/* ------------------------------------------------------------
   Q9 選択肢一覧（複数選択・順不同）
   ------------------------------------------------------------ */
const Q9_LABELS = {
  "a9-1": "全部旅行に行ったりご馳走を食べに行くなどして祝いたい",
  "a9-2": "全部ではなくていいがどれかは旅行に行ったりご馳走を食べに行くなどして祝いたい",
  "a9-3": "旅行や外食よりも家で祝いたい",
  "a9-4": "毎回プレゼントを贈りあいたい",
  "a9-5": "毎回ではなくてもいいがプレゼントを贈りあいたい",
  "a9-6": "出かけたりプレゼントを用意したりはいらないが、一言お祝いの言葉はほしい",
  "a9-7": "記念日やその付近でのデートでも普段どおりの生活で良い",
};

/* ------------------------------------------------------------
   ラジオ選択肢ラベル（表示用 & 統計用の全文テキストとして共用）
   ------------------------------------------------------------ */
const Q5_LABELS = {
  "a5-1": "車が多かった",
  "a5-2": "公共交通機関が多かった",
};

const Q10_LABELS = {
  "a10-1": "同年代男子に人気な習い事を調べていくつか見学に連れて行く",
  "a10-2": "同年代男子に人気な習い事を調べて資料を見せる",
  "a10-3": "自分が過去に通っていた習い事の話をしてみる",
  "a10-4": "興味がわいたら通わせられるように準備をしつつ今は息子にはこれ以上声かけはしない",
  "a10-5": "子どもをもつことは考えていない",
};

const Q11_LABELS = {
  "a11-1": "その日だけは娘1人で帰らせる",
  "a11-2": "親戚か友人などに迎えに行ってもらうように頼む",
  "a11-3": "送迎サービスを探し、お金を払って利用する",
  "a11-4": "夫婦どちらかは間に合うように何がなんでも調整する",
  "a11-5": "子どもをもつことは考えていない",
};

/* ------------------------------------------------------------
   ランキングUI制御
   ------------------------------------------------------------ */
const rankingState = {
  q4: [],
  q6: [],
};

function rankingKey(groupId) {
  if (groupId === "q4Ranking") return "q4";
  if (groupId === "q6Ranking") return "q6";
  return null;
}

function setupRankingGroup(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  const key = rankingKey(groupId);
  if (!key) return;

  group.querySelectorAll(".rank-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.value;
      const arr   = rankingState[key];
      const idx   = arr.indexOf(value);
      if (idx === -1) { arr.push(value); } else { arr.splice(idx, 1); }
      renderRankingGroup(groupId);
    });
  });
}

function renderRankingGroup(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  const key = rankingKey(groupId);
  if (!key) return;
  const arr = rankingState[key];

  group.querySelectorAll(".rank-option").forEach((btn) => {
    const value = btn.dataset.value;
    const order = arr.indexOf(value);
    const numEl = btn.querySelector(".rank-number");
    if (order === -1) {
      btn.classList.remove("selected");
      numEl.textContent = "";
    } else {
      btn.classList.add("selected");
      numEl.textContent = String(order + 1);
    }
  });
}

function resetRankingGroup(groupId) {
  const key = rankingKey(groupId);
  if (!key) return;
  rankingState[key] = [];
  renderRankingGroup(groupId);
}

/* 復元時：現在のボタンに実在する値のみ採用（古い下書きのずれ防止） */
function restoreRankingGroup(groupId, savedOrder) {
  const key = rankingKey(groupId);
  if (!key) return;
  const group = document.getElementById(groupId);
  const validValues = group
    ? Array.from(group.querySelectorAll(".rank-option")).map(btn => btn.dataset.value)
    : [];
  rankingState[key] = Array.isArray(savedOrder)
    ? savedOrder.filter(v => validValues.includes(v))
    : [];
  renderRankingGroup(groupId);
}

/* ------------------------------------------------------------
   Q9 詳細欄の表示/非表示（a9-4 or a9-5 選択時のみ）
   ------------------------------------------------------------ */
function toggleQ9Detail(values) {
  const el = document.getElementById("q9Detail");
  if (!el) return;
  const arr  = Array.isArray(values) ? values : [];
  const show = arr.includes("a9-4") || arr.includes("a9-5");
  el.style.display = show ? "block" : "none";
  if (!show) el.value = "";
}

function getCheckedQ9() {
  return Array.from(document.querySelectorAll('input[name="q9"]:checked')).map(el => el.value);
}

/* ------------------------------------------------------------
   フォーム値の収集
   ------------------------------------------------------------ */
function collectFormData() {
  const q5Radio  = document.querySelector('input[name="q5"]:checked');
  const q10Radio = document.querySelector('input[name="q10"]:checked');
  const q11Radio = document.querySelector('input[name="q11"]:checked');

  return {
    q1good:   document.getElementById("q1good").value,
    q1bad:    document.getElementById("q1bad").value,
    q2good:   document.getElementById("q2good").value,
    q2bad:    document.getElementById("q2bad").value,
    q3:       document.getElementById("q3").value,
    q4:       rankingState.q4.slice(),
    q5:       q5Radio  ? q5Radio.value  : "",
    q6:       rankingState.q6.slice(),
    q7:       document.getElementById("q7").value,
    q8:       document.getElementById("q8").value,
    q9:       getCheckedQ9(),
    q9Detail: document.getElementById("q9Detail").value,
    q10:      q10Radio ? q10Radio.value : "",
    q11:      q11Radio ? q11Radio.value : "",
    q12:      document.getElementById("q12").value,
    q13:      document.getElementById("q13").value,
  };
}

/* ------------------------------------------------------------
   フォームへの値の復元
   ------------------------------------------------------------ */
function restoreFormData(data) {
  if (!data) return;

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined) el.value = val;
  };

  setText("q1good", data.q1good);
  setText("q1bad",  data.q1bad);
  setText("q2good", data.q2good);
  setText("q2bad",  data.q2bad);
  setText("q3",     data.q3);
  setText("q7",     data.q7);
  setText("q8",     data.q8);
  setText("q12",    data.q12);
  setText("q13",    data.q13);

  restoreRankingGroup("q4Ranking", data.q4);
  restoreRankingGroup("q6Ranking", data.q6);

  if (data.q5) {
    const r = document.querySelector(`input[name="q5"][value="${data.q5}"]`);
    if (r) r.checked = true;
  }

  if (Array.isArray(data.q9)) {
    data.q9.forEach((val) => {
      const c = document.querySelector(`input[name="q9"][value="${val}"]`);
      if (c) c.checked = true;
    });
    toggleQ9Detail(data.q9);
    setText("q9Detail", data.q9Detail);
  }

  if (data.q10) {
    const r = document.querySelector(`input[name="q10"][value="${data.q10}"]`);
    if (r) r.checked = true;
  }
  if (data.q11) {
    const r = document.querySelector(`input[name="q11"][value="${data.q11}"]`);
    if (r) r.checked = true;
  }
}

/* ------------------------------------------------------------
   バリデーション（本送信時のみ）
   ------------------------------------------------------------ */
function validate(data) {
  const errors = [];

  if (!data.q1good.trim()) errors.push("Q1: 会社で褒められることを入力してください。");
  if (!data.q1bad.trim())  errors.push("Q1: 会社で注意されることを入力してください。");
  if (!data.q2good.trim()) errors.push("Q2: 友人・元恋人から褒められることを入力してください。");
  if (!data.q2bad.trim())  errors.push("Q2: 友人・元恋人から注意されることを入力してください。");
  if (!data.q3.trim())     errors.push("Q3: 人生で一番大きな壁・挫折について入力してください。");

  const q4Total = document.querySelectorAll("#q4Ranking .rank-option").length;
  const q6Total = document.querySelectorAll("#q6Ranking .rank-option").length;

  if (data.q4.length < q4Total) errors.push("Q4: すべての選択肢を順位付けしてください。");
  if (!data.q5)                 errors.push("Q5: 家族で出かけるときの移動手段を選択してください。");
  if (data.q6.length < q6Total) errors.push("Q6: すべての選択肢を順位付けしてください。");
  if (!data.q7.trim())          errors.push("Q7: 結婚したら2人でしたいことを入力してください。");
  if (!data.q8.trim())          errors.push("Q8: 子どもが生まれたらしたいことを入力してください。");

  if (!data.q9 || data.q9.length === 0)
    errors.push("Q9: イベントごとの過ごし方を選択してください（複数選択可）。");
  if ((data.q9.includes("a9-4") || data.q9.includes("a9-5")) && !data.q9Detail.trim())
    errors.push("Q9: プレゼントの詳細を入力してください。");

  if (!data.q10) errors.push("Q10: 回答を選択してください。");
  if (!data.q11) errors.push("Q11: 回答を選択してください。");
  if (!data.q12.trim()) errors.push("Q12: 意見が食い違ったときどうしたいかを入力してください。");
  if (!data.q13.trim()) errors.push("Q13: 夫婦や家族のなかで守っていきたいルール、家訓を入力してください。");

  return errors;
}

/* ============================================================
   統計用データの抽出（Analyticsシート行）
   Analyticsシートに列がある項目のみを平文で送る。
   ※ q6（手に入るとしたら嬉しい順のランキング）は列自体が
     存在しないため対象外。
   選択式の項目は、集計時にそのまま使えるよう選択肢の全文を入れる。
   ============================================================ */
function buildAnalyticsPayload(data) {
  const rankingText = (arr) => (Array.isArray(arr) && arr.length > 0)
    ? arr.map((v, i) => `${i + 1}位:${v}`).join("、")
    : "";
  const checkText = (arr) => (Array.isArray(arr) && arr.length > 0)
    ? arr.map(v => Q9_LABELS[v] || v).join("、")
    : "";

  return {
    q1good: data.q1good || "",
    q1bad:  data.q1bad  || "",
    q2good: data.q2good || "",
    q2bad:  data.q2bad  || "",
    q3:     data.q3 || "",
    q4:     rankingText(data.q4),
    q5:     Q5_LABELS[data.q5] || "",
    q7:     data.q7 || "",
    q8:     data.q8 || "",
    q9:     checkText(data.q9),
    q9Detail: data.q9Detail || "",
    q10:    Q10_LABELS[data.q10] || "",
    q11:    Q11_LABELS[data.q11] || "",
    q12:    data.q12 || "",
    q13:    data.q13 || "",
  };
}

/* ============================================================
   フォーム要素を隠す（ビューモード／状態表示に切り替える共通処理）
   ============================================================ */
function hideFormElements() {
  document.querySelectorAll(
    ".container > label, .container > input, .container > textarea, " +
    ".container > div.ranking-group, .container > div.button-group, " +
    ".container > div#shareModal"
  ).forEach(el => (el.style.display = "none"));
}

/* ============================================================
   読み込み中／エラーなどの状態表示（共有リンクを開いたとき用）
   ============================================================ */
function showStateCard(title, text, isLoading = false) {
  hideFormElements();
  const container = document.getElementById("viewMode");
  container.style.display = "block";
  container.innerHTML = `
    <div class="view-header state-card">
      ${isLoading ? `
        <div class="state-spinner">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_light.svg" class="spinner-light" alt="読み込み中">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_dark.svg" class="spinner-dark" alt="読み込み中">
        </div>
      ` : ""}
      <p class="view-label">${escapeHTML(title)}</p>
      <p class="state-text">${escapeHTML(text)}</p>
    </div>
  `;
}

/* ============================================================
   共有リンクを開いたときの処理
   ・URLの ?id=... がスプレッドシート上のレコードを指す
   ・URLの #以降 が復号鍵（サーバーには送信されない）
   ・閲覧にはLINEログインが必須（viewerHashによるアクセス制御のため）
   ============================================================ */
async function handleSharedView(id) {
  // ここに来た時点で liff.init() は完了済み（呼び出し元のメイン処理を参照）。
  showStateCard("読み込み中…", "回答内容を確認しています。少々お待ちください。", true);

  const keyBase64 = location.hash ? location.hash.slice(1) : "";
  if (!keyBase64) {
    showStateCard(
      "リンクが不完全です",
      "共有リンクが途中で切れているか、正しくコピーされていない可能性があります。共有した相手にもう一度リンクを送ってもらってください。"
    );
    return;
  }

  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  let key;
  try {
    key = await importShareKey(keyBase64);
  } catch (e) {
    console.error("key import error", e);
    showStateCard("リンクが正しくありません", "共有リンクが壊れている可能性があります。");
    return;
  }

  let viewerHash;
  try {
    const userId = getLineUserId();
    viewerHash = await sha256Hex(userId);
  } catch (e) {
    console.error("get user id error", e);
    showStateCard(
      "エラー",
      "LINEアカウント情報の確認に失敗しました。時間をおいてもう一度お試しください。" +
      "（詳細: " + (e && e.message ? e.message : String(e)) + "）"
    );
    return;
  }

  let result;
  try {
    const url = `${GAS_ENDPOINT}?action=view&id=${encodeURIComponent(id)}&viewerHash=${encodeURIComponent(viewerHash)}`;
    const resp = await fetch(url, { method: "GET" });
    result = await resp.json();
  } catch (e) {
    console.error("fetch view error", e);
    showStateCard("通信エラー", "回答内容を取得できませんでした。通信環境を確認してもう一度お試しください。");
    return;
  }

  if (!result.ok) {
    if (result.reason === "forbidden") {
      showStateCard(
        "閲覧できません",
        "このリンクは最初に開いた方専用です。転送されたリンクは、その方以外は閲覧できない仕組みになっています。"
      );
    } else if (result.reason === "revoked" || result.reason === "expired" || result.reason === "deleted") {
      showStateCard("リンクが無効です", "このリンクはすでに無効になっています。最新の共有リンクを送ってもらってください。");
    } else if (result.reason === "not_found") {
      showStateCard("リンクが見つかりません", "このリンクは存在しないか、削除された可能性があります。");
    } else {
      showStateCard("エラー", "回答内容を取得できませんでした。時間をおいて再度お試しください。");
    }
    return;
  }

  let data;
  try {
    data = await decryptJSON(result.cipherText, key);
  } catch (e) {
    console.error("decrypt error", e);
    showStateCard("復号に失敗しました", "リンクの一部が正しくない可能性があります。共有した相手にもう一度リンクを送ってもらってください。");
    return;
  }

  renderViewMode(data);
}

/* ------------------------------------------------------------
   ランキング配列 → 「1位：◯◯」形式のHTML
   ------------------------------------------------------------ */
function rankingListHTML(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "未回答";
  return arr.map((item, i) => `${i + 1}位：${escapeHTML(item)}`).join("<br>");
}

/* ------------------------------------------------------------
   Q9 選択結果 → 表示用HTML
   ------------------------------------------------------------ */
function q9AnswerHTML(data) {
  const values = Array.isArray(data.q9) ? data.q9 : [];
  if (values.length === 0) return "未回答";
  let html = values.map((v) => `・${escapeHTML(Q9_LABELS[v] || v)}`).join("<br>");
  if ((values.includes("a9-4") || values.includes("a9-5")) && data.q9Detail) {
    html += `<br>（詳細：${escapeHTML(data.q9Detail)}）`;
  }
  return html;
}

/* ------------------------------------------------------------
   ビューモード：回答をカード表示
   ------------------------------------------------------------ */
function renderViewMode(data, options = {}) {
  const { selfPreview = false, onShare = null } = options;

  const q5Labels  = Q5_LABELS;
  const q10Labels = Q10_LABELS;
  const q11Labels = Q11_LABELS;

  // ← 修正：Q12をrows配列の内側に正しく追加
  const rows = [
    { q: "Q1 会社でどんなことを褒められますか？",
      a: `褒められること：${data.q1good || "未回答"}\n注意されること：${data.q1bad || "未回答"}` },
    { q: "Q2 友人や元恋人からどんなことを褒められますか？",
      a: `褒められること：${data.q2good || "未回答"}\n注意されること：${data.q2bad || "未回答"}` },
    { q: "Q3 人生で「一番大きな壁・挫折」だったと感じる出来事は何ですか？", a: data.q3 || "未回答" },
    { q: "Q4 次の働き方・休暇について、もし実現できたら嬉しい順",
      html: rankingListHTML(data.q4) },
    { q: "Q5 子どものころ、家族で出かけるときの移動手段は？",
      a: q5Labels[data.q5] || "未回答" },
    { q: "Q6 次の中でも手に入るとしたら嬉しい順",
      html: rankingListHTML(data.q6) },
    { q: "Q7 結婚したら2人でしたいことは何ですか？", a: data.q7 || "未回答" },
    { q: "Q8 子どもが生まれたら家族でしたいことは何ですか？", a: data.q8 || "未回答" },
    { q: "Q9 記念日や誕生日、クリスマスなどのイベントごとはどう過ごしたいですか？（複数選択）",
      html: q9AnswerHTML(data) },
    { q: "Q10 習い事に興味がない息子にどうしますか？", a: q10Labels[data.q10] || "未回答" },
    { q: "Q11 塾の迎えに行けない日、どうしますか？",  a: q11Labels[data.q11] || "未回答" },
    { q: "Q12 意見が食い違ったときはどうしたいですか？",  a: data.q12 || "未回答" },
    { q: "Q13 夫婦や家族のなかで守っていきたいルール、家訓はありますか？",  a: data.q13 || "未回答" },
  ];

  hideFormElements();

  const formURL = location.href.split("?")[0].split("#")[0];

  const descEl = document.querySelector(".form-header .form-description");
  if (descEl) {
    descEl.innerHTML =
      "回答を共有してお互いのことを知りましょう。<br>" +
      "回答内容だけじゃなく、なぜそう思ってるのか、この場合はどう変わるかなども質問し合ってみましょう。";
  }

  const container = document.getElementById("viewMode");
  container.style.display = "block";
  container.innerHTML = `
    ${selfPreview ? `
    <div class="cta-card share-confirm-card">
      <div class="cta-content" style="text-align:center;">
        <h3 class="cta-title">この内容を共有します</h3>
        <p class="cta-text">内容を確認したら、共有先を選んでください。</p>
        <button type="button" id="goShareBtn" class="cta-button">
          共有先を選ぶ <span class="cta-arrow">›</span>
        </button>
      </div>
    </div>
    ` : ""}

    ${!selfPreview ? `
    <div class="view-header">
      <p class="view-label">回答内容</p>
      ${data._shareName ? `<p class="view-name">${escapeHTML(data._shareName)} さんの回答</p>` : ""}
    </div>
    ` : ""}

    ${rows.map(({ q, a, html }) => `
      <div class="view-item">
        <p class="view-question">${escapeHTML(q)}</p>
        <p class="view-answer">${html ? html : escapeHTML(a).replace(/\n/g, "<br>")}</p>
      </div>
    `).join("")}

    ${!selfPreview ? `
    <div class="cta-card">
      <img src="image1.PNG" class="cta-image-left" alt="">
      <div class="cta-content">
        <h3 class="cta-title">あなたの価値観も共有してみませんか？</h3>
        <p class="cta-text">
          婚活・交際前の自己開示は、<br>
          お互いを知る大切なきっかけになります。<br>
          あなたの考えや価値観をアンケートで伝えてみましょう。
        </p>
        <button type="button" id="ctaButton" class="cta-button" data-href="${formURL}">
          私も回答する <span class="cta-arrow">›</span>
        </button>
      </div>
    </div>
    ` : ""}
  `;

  if (selfPreview) {
    const goShareBtn = document.getElementById("goShareBtn");
    if (goShareBtn && typeof onShare === "function") {
      goShareBtn.addEventListener("click", onShare);
    }
    return;
  }

  const ctaButton = document.getElementById("ctaButton");
  if (ctaButton) {
    ctaButton.addEventListener("click", () => {
      if (confirm("自己開示QA part3を開く")) {
        window.location.href = ctaButton.dataset.href;
      }
    });
  }
}

/* ------------------------------------------------------------
   共有：シェアターゲットピッカー用 Flexメッセージ
   長い共有URLはボタン(uriアクション)の中に格納するため、
   相手に見える本文には長いリンクが表示されない。
   ※ uriアクションのURLは1000文字以内という制限があるため、
     超える場合は liff.shareTargetPicker 側でエラーになり、
     呼び出し元で従来のURLスキーム方式にフォールバックする。
   ※ hero画像のURLは、LINEのサーバーから読み込める公開HTTPS URL
     である必要がある（ローカルパスや相対パスは不可）。
     画像は1MB以下を推奨。PNGの透過部分はそのまま送ると
     反映されない場合があるため、白背景に合成したJPEGを使用する。
   ------------------------------------------------------------ */
const HEADER_IMAGE_URL = "https://marriagesketch.github.io/-jikokaiji_qa3-/image_message.jpg";

function buildShareFlexMessage(shareName, shareURL) {
  const nameLine = shareName ? `${shareName}さんの回答が届きました` : "回答が届きました";

  return {
    type: "flex",
    altText: `婚活 自己開示QA Part3 - ${nameLine}`,
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: HEADER_IMAGE_URL,
        size: "full",
        aspectRatio: "3:2",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "婚活 自己開示QA Part3", size: "xs", weight: "bold", color: "#d96c7d" },
          { type: "text", text: nameLine, size: "lg", weight: "bold", wrap: true, margin: "sm" },
          { type: "text", text: "ボタンから回答内容を確認できます。", size: "sm", color: "#888888", wrap: true, margin: "md" }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "20px",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#f48ca0",
            action: { type: "uri", label: "回答をみる", uri: shareURL }
          }
        ]
      }
    }
  };
}

/* ------------------------------------------------------------
   共有先を選んで送信する
   1. シェアターゲットピッカーが使える場合はそちらを優先
      （Flexメッセージとして直接送信、送信後にトーク画面へ遷移しない）
   2. 使えない・失敗した場合は、従来のURLスキーム方式（送信先を
      選択画面を開いてテキストメッセージを送る）にフォールバック
   ------------------------------------------------------------ */
async function shareToOthers(flexMessage, fallbackLineSchemeURL) {
  if (liff.isApiAvailable("shareTargetPicker")) {
    try {
      await liff.shareTargetPicker([flexMessage], { isMultiple: true });
      return;
    } catch (e) {
      console.warn("shareTargetPicker failed, falling back to URL scheme:", e);
    }
  }

  if (liff.isInClient()) {
    window.location.href = fallbackLineSchemeURL;
  } else {
    window.open(fallbackLineSchemeURL, "_blank");
  }
}

/* ------------------------------------------------------------
   友だち追加チェック
   LINE公式アカウントを友だち追加済みかを確認し、未追加であれば
   友だち追加ダイアログを表示する。
   ※ LIFF初期化・ログイン済みの状態で呼び出すこと（liff.init は呼ばない）
   ------------------------------------------------------------ */
async function checkFriendship() {
  try {
    const friendship = await liff.getFriendship();
    if (!friendship.friendFlag) {
      try {
        await liff.requestFriendship();
      } catch (error) {
        console.warn("友だち追加リクエスト失敗（ユーザーがキャンセルした可能性があります）:", error);
      }
    }
  } catch (error) {
    console.warn("友だち確認をスキップ:", error);
  }
}

/* ------------------------------------------------------------
   メイン処理
   ------------------------------------------------------------ */
(async () => {

  /* ----- LIFF 初期化（必ず最初に1回だけ実行） -----
     共有リンク判定に使うURL（?id=...#key）の読み取りは、
     必ずこの後で行う。ログインのリダイレクトを経由して
     戻ってきた直後は、URLが一時的に ?liff.state=... の形に
     なっていて ?id=... が正しく読み取れないことがあるため。
  ----- */
  try {
    await liff.init({ liffId: LIFF_ID });
  } catch (e) {
    console.error("LIFF init failed", e);
    alert("LIFFの初期化に失敗しました。");
    return;
  }

  /* ----- 共有リンク判定（?id=... が付いている場合） ----- */
  const sharedId = new URLSearchParams(location.search).get("id");
  if (sharedId) {
    await handleSharedView(sharedId);
    return;
  }

  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  /* ----- 友だち追加チェック（未追加なら追加ダイアログを表示） ----- */
  await checkFriendship();

  /* ----- ランキングUIの初期化 ----- */
  setupRankingGroup("q4Ranking");
  setupRankingGroup("q6Ranking");

  /* ----- Q9 チェックボックス：詳細欄の表示制御 ----- */
  document.querySelectorAll('input[name="q9"]').forEach(c =>
    c.addEventListener("change", () => toggleQ9Detail(getCheckedQ9()))
  );
  toggleQ9Detail(getCheckedQ9());

  /* ----- localStorage から下書き復元 ----- */
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) restoreFormData(JSON.parse(saved));
  } catch (_) {}

  /* ----- 下書き保存 ----- */
  document.getElementById("draftBtn").addEventListener("click", () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(collectFormData()));
      alert("下書きを保存しました。");
    } catch (_) {
      alert("下書きの保存に失敗しました。");
    }
  });

  /* ----- フォームクリア ----- */
  document.getElementById("clearBtn").addEventListener("click", () => {
    if (!confirm("入力内容をすべてクリアしますか？")) return;

    ["q1good","q1bad","q2good","q2bad","q3","q7","q8","q9Detail","q12","q13"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });

    document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
      .forEach(r => (r.checked = false));

    resetRankingGroup("q4Ranking");
    resetRankingGroup("q6Ranking");

    toggleQ9Detail([]);

    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  });

  /* ----- 送信ボタン ----- */
  document.getElementById("submitBtn").addEventListener("click", () => {
    const data   = collectFormData();
    const errors = validate(data);

    if (errors.length > 0) {
      alert("以下の項目を入力してください。\n\n" + errors.join("\n"));
      return;
    }

    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (_) {}

    const modal = document.getElementById("shareModal");
    modal.classList.remove("hidden");
    modal.classList.add("show");

    document.getElementById("submitBtn").disabled = true;
  });

  /* ----- 共有ボタン ----- */
  document.getElementById("shareBtn").addEventListener("click", async () => {
    const shareBtn   = document.getElementById("shareBtn");
    const shareName  = document.getElementById("shareName").value.trim();
    const data       = collectFormData();
    data._shareName  = shareName;

    shareBtn.disabled = true;
    const originalLabel = shareBtn.textContent;
    shareBtn.textContent = "送信中…";

    try {
      const userId    = getLineUserId();
      const ownerHash = await sha256Hex(userId);

      const id = (crypto.randomUUID ? crypto.randomUUID() : fallbackUUID());
      const { key, base64: keyBase64 } = await generateShareKey();
      const cipherText = await encryptJSON(data, key);
      const analytics  = buildAnalyticsPayload(data);

      const resp = await fetch(GAS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // preflight回避のため text/plain を使用
        body: JSON.stringify({ action: "share", id, cipherText, ownerHash, analytics, schemaVersion: 1 }),
      });
      const result = await resp.json();
      if (!result.ok) throw new Error(result.reason || "share_failed");

      const base     = location.href.split("?")[0].split("#")[0];
      const shareURL = `${base}?id=${id}#${keyBase64}`;

      const previewMsg = shareName
        ? `${shareName}さんの婚活　自己開示QA part3の回答が届きました。\n回答をみる→${shareURL}`
        : `婚活　自己開示QA part3の回答が届きました。\n回答をみる→${shareURL}`;

      const flexMessage = buildShareFlexMessage(shareName, shareURL);

      const modal = document.getElementById("shareModal");
      modal.classList.remove("show");
      modal.classList.add("hidden");

      renderViewMode(data, {
        selfPreview: true,
        onShare: () => {
          const lineShareURL = `https://line.me/R/msg/text/?${encodeURIComponent(previewMsg)}`;
          shareToOthers(flexMessage, lineShareURL);
        },
      });

      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      console.error("share error", e);
      alert("共有の準備に失敗しました。通信環境を確認してもう一度お試しください。");
      document.getElementById("submitBtn").disabled = false;
    } finally {
      shareBtn.disabled = false;
      shareBtn.textContent = originalLabel;
    }
  });

  /* ----- モーダル外クリックで閉じる ----- */
  document.getElementById("shareModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.remove("show");
      e.currentTarget.classList.add("hidden");
    }
  });

})();

/* crypto.randomUUID が使えない古い環境用のフォールバック */
function fallbackUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
