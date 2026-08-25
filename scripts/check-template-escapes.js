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
const templateRegions = [];
for (let i = 0; i < srcLines.length; i++) {
  if (srcLines[i].includes("return " + BT)) {
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
            // 检查是否在 <script> 块内
            let inScript = false;
            for (let j = region.start; j <= i; j++) {
              if (srcLines[j].includes("<script>")) inScript = true;
              if (srcLines[j].includes("</script>")) inScript = false;
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
  const html = srcLines.slice(region.start + 1, region.end).join("\n");
  const scriptRegex = new RegExp("<script>([\\s\\S]*?)<\\/script>", "g");
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
