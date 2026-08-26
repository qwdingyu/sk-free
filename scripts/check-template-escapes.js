#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// check-template-escapes.js — 模板字面量转义安全检查
//
// 【根因】Cloudflare Worker 的 admin 页面嵌入在 JS 模板字面量中的完整 HTML。
//   模板字面量会解释转义序列：\n → 换行，\t → 制表符。
//   如果 <script> 块的字符串字面量中包含 \n（源码中单个 \n），
//   模板字面量会把它变成真正的换行符 → 字符串跨行 → JS 语法错误 →
//   整个 <script> 块解析失败 → 所有函数（doLogin 等）未定义。
//
// 【检测策略】
//   1. 找到所有模板字面量区域（return ` ... `;）
//   2. 在 <script> 块内，逐行检查源码中的单反斜杠转义（\n \t \r）
//   3. 如果该行有未闭合引号（字符串跨行），报错
//   4. 提取脚本做 node --check 语法验证（辅助确认）
//
// 用法：node scripts/check-template-escapes.js [file]
// 退出码：0 = 通过，1 = 发现问题
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BT = "\x60"; // backtick
const filePath = process.argv[2] || path.join(__dirname, "../worker/index.js");
const src = fs.readFileSync(filePath, "utf8");
const srcLines = src.split("\n");

// ── 找到所有模板字面量区域 ──────────────────────────────────────────────────
// 两种文件，两种形态：
//   1. index.js（手写）：return `...`;  —— 模板内容是未转义形态
//   2. broadcast-html.js（build 产物）：export const broadcastHtml = \`...\`;
//      反引号被 build-html.js 转义成 \`、`; 结束符变成 \`;
//      通用正则在这里全部失配，必须按转义形态显式匹配。
const ESC_BT = "\\" + BT; // 转义后的反引号：\`
const templateRegions = [];
const isBroadcast = path.basename(filePath) === "broadcast-html.js";

if (isBroadcast) {
  // 广播产物：模板定界符是未转义的反引号（打开 1 个 + 关闭 1 个），
  // 模板内容里的反引号才是 `\` 转义形态（build 只转义 result 内容）。
  // 开始行：`export const broadcastHtml = \``（行首锚定，内容从同行开始）；
  // 结束行：开始之后最后一个 `\`;` —— 覆盖真正关闭符，跳过内容里的 `\`;`。
  const startRe = new RegExp("^\\s*export\\s+const\\s+\\w+\\s*=\\s*" + BT);
  const startIdx = srcLines.findIndex((l) => startRe.test(l));
  if (startIdx >= 0) {
    let endIdx = -1;
    for (let j = startIdx + 1; j < srcLines.length; j++) {
      if (srcLines[j].includes(BT + ";")) endIdx = j;
    }
    if (endIdx > startIdx) templateRegions.push({ start: startIdx, end: endIdx });
  }
} else {
  for (let i = 0; i < srcLines.length; i++) {
    const isReturn = srcLines[i].includes("return " + BT);
    const isExport = /(?:export\s+)?(?:const|let)\s+\w+\s*=\s*\`/.test(srcLines[i]);
    if (isReturn || isExport) {
      const start = i;
      for (let j = i + 1; j < srcLines.length; j++) {
        // 关闭行可能是 `; 单独一行，也可能是 </html>`; 等含内容的行
        if (srcLines[j].includes(BT + ";")) {
          templateRegions.push({ start, end: j });
          break;
        }
      }
    }
  }
}

// ── 策略 1：源码级扫描 ─────────────────────────────────────────────────────
let issues = [];

for (const region of templateRegions) {
  for (let i = region.start; i <= region.end; i++) {
    const line = srcLines[i];

    // 在源码中查找单反斜杠 + n/t/r（会被模板字面量解释）
    // \\n (双反斜杠) → 正确，输出字面量 \n
    // \n (单反斜杠) → 危险，输出真正的换行符
    for (let pos = 0; pos < line.length - 1; pos++) {
      if (line[pos] === "\\") {
        // 计算连续反斜杠数量
        let bsCount = 0;
        let p = pos;
        while (p >= 0 && line[p] === "\\") { bsCount++; p--; }
        // 奇数个反斜杠 = 这个反斜杠是"活跃的"（不是被转义的）
        if (bsCount % 2 === 1) {
          const nextChar = line[pos + 1];
          if ("ntrv".includes(nextChar)) {
            // 检查是否在 <script> 块内（含 <script defer> 等带属性形态；
            // 注意 </script> 也以 <script 开头，要先排除闭合标签）
            let inScript = false;
            for (let j = region.start; j <= i; j++) {
              const t = srcLines[j].trim();
              if (t.startsWith("</script")) inScript = false;
              else if (t.includes("<script")) inScript = true;
            }

            if (inScript) {
              // 检查这行是否有未闭合的引号（字符串跨行）
              let singleQ = 0, doubleQ = 0;
              for (let p2 = 0; p2 < line.length; p2++) {
                if (line[p2] === "\\") { p2++; continue; }
                if (line[p2] === "'") singleQ++;
                if (line[p2] === '"') doubleQ++;
              }
              const hasUnclosed = (singleQ % 2 === 1) || (doubleQ % 2 === 1);

              if (hasUnclosed) {
                const name = nextChar === 'n' ? '换行符' : nextChar === 't' ? '制表符' : '回车符';
                issues.push({
                  line: i + 1,
                  escape: "\\" + nextChar,
                  escapeName: name,
                  content: line.trim().substring(0, 100),
                });
                break; // 每行只报一次
              }
            }
          }
        }
      }
    }
  }
}

// ── 策略 2：提取脚本做语法检查 ──────────────────────────────────────────────
let syntaxErrors = [];
for (const region of templateRegions) {
  let html = srcLines.slice(region.start + 1, region.end).join("\n");

  // 广播产物（build-html.js 生成）的模板字面量是转义过的：
  //   ` → \`、${ → \${、\ → \\
  // 必须按构建的逆序还原，否则提取出的 <script> 内容里到处是 \`，
  // node --check 会误报语法错误。index.js 的手写模板不需要这一步。
  if (path.basename(filePath) === "broadcast-html.js") {
    html = html
      .replace(/\\\$\{/g, "${")
      .replace(/\\`/g, "`")
      .replace(/\\\\/g, "\\");
  }

  // 匹配带属性的 <script defer> 与普通 <script>：
  // 之前只认 <script>，而广播产物内联的是 <script defer>，策略 2 永远
  // 提取不到任何内容，语法检查是假的"通过"。
  const scriptRegex = new RegExp("<script[^>]*>([\\s\\S]*?)<\\/script>", "g");
  let m;
  let scriptIdx = 0;
  while ((m = scriptRegex.exec(html)) !== null) {
    const scriptContent = m[1];
    if (scriptContent.length > 50) {
      const tmpFile = `/tmp/_qc_check_${scriptIdx}.js`;
      fs.writeFileSync(tmpFile, scriptContent);
      try {
        execSync(`node --check "${tmpFile}" 2>&1`, { stdio: "pipe" });
      } catch (e) {
        const stderr = e.stderr?.toString() || e.stdout?.toString() || "";
        const lineMatch = stderr.match(/:(\d+)/);
        syntaxErrors.push({
          scriptIdx,
          lineInScript: lineMatch ? parseInt(lineMatch[1]) : -1,
          error: stderr.split("\n").find(l => l.includes("SyntaxError")) || stderr.split("\n")[0],
        });
      }
      scriptIdx++;
    }
  }
}

// ── 输出结果 ─────────────────────────────────────────────────────────────────
console.log("\n📋 模板字面量转义安全检查: " + path.basename(filePath));
console.log("   模板字面量区域: " + templateRegions.length + " 个");

if (issues.length > 0) {
  console.log("\n❌ 发现 " + issues.length + " 个转义问题:\n");
  for (const issue of issues) {
    console.log("   行 " + issue.line + ": 源码中的 " + issue.escape + " 会在 <script> 字符串中变成" + issue.escapeName);
    console.log("   内容: " + issue.content);
    console.log("   修复: 将 " + issue.escape + " 改为 \\x5c" + issue.escape[1]);
    console.log("");
  }
} else {
  console.log("\n✅ 源码级转义检查通过");
}

if (syntaxErrors.length > 0) {
  console.log("\n❌ 发现 " + syntaxErrors.length + " 个语法错误:\n");
  for (const err of syntaxErrors) {
    console.log("   Script #" + err.scriptIdx + ", 行 " + err.lineInScript + ": " + err.error);
  }
} else {
  console.log("✅ 脚本语法检查通过");
}

const total = issues.length + syntaxErrors.length;
if (total > 0) {
  console.log("\n🚫 检查失败: " + total + " 个问题必须修复后才能部署");
  process.exit(1);
} else {
  console.log("\n✅ 所有检查通过，可以安全部署");
  process.exit(0);
}
