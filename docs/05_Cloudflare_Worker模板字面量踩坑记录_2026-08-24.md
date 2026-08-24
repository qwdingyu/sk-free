# 05 Cloudflare Worker 模板字面量踩坑记录

> 日期：2026-08-24
> 状态：已解决
> 影响范围：管理后台 admin 页面所有动态生成的内联事件处理器

## 一、问题描述

管理后台 admin 页面部署后，浏览器控制台报错：
```
Uncaught ReferenceError: doLogin is not defined
    at HTMLButtonElement.onclick (admin:101:33)
```

**表面现象**：`doLogin` 函数未定义，登录按钮无法点击。
**实际原因**：整个 `<script>` 块因语法错误无法解析，导致所有函数（包括 `doLogin`）都未被定义。

## 二、根因分析

### 2.1 架构背景

Cloudflare Worker 的 admin 页面是**嵌入在 JavaScript 模板字面量中的完整 HTML**：

```javascript
// worker/index.js
function getAdminHtml() {
  return `<!DOCTYPE html>
<html>
<head>...</head>
<body>
  <button onclick="doLogin()">登 录</button>
  ...
  <script>
  function doLogin() { ... }
  // ... 其他函数
  </script>
</body>
</html>`;
}
```

### 2.2 转义层级问题

当 HTML 中有**动态数据**需要通过内联 `onclick` 传递时，涉及 **4 层转义**：

```
第1层：源代码中的模板字面量（JavaScript 字符串）
    ↓ 模板字面量处理
第2层：HTTP 响应中的 HTML（浏览器收到的内容）
    ↓ HTML 属性解析
第3层：HTML 属性值（浏览器提取的字符串）
    ↓ JavaScript 字符串解析
第4层：内联 JS 执行（最终的函数调用）
```

### 2.3 具体出错过程

原始代码（模板字面量中）：
```javascript
'<button onclick="showEdit(\\'' + esc(s.name) + '\\')">编辑</button>'
```

**逐层解析**：

| 层级 | 内容 | 说明 |
|------|------|------|
| 源代码 | `\\\\''` | 4个反斜杠 + 2个引号 |
| 模板字面量处理 | `\\''` | `\\\\` → `\\`，`''` 保持 |
| 浏览器 HTML 属性 | `toggleSelect(\'SiteName'` | `\\` → `\`，`'` 是字面字符 |
| JS 字符串解析 | `\'` 是无效转义 | `\` 在 `'` 字符串中不转义 `'` |

**结果**：`\'` 导致 JS 字符串在 `'` 处提前关闭，后续代码变成"悬空字符串"，引发 `SyntaxError: Unexpected string`。

### 2.4 为什么 Node.js `--check` 会误报

从浏览器提取的 `<script>` 内容用 `node --check` 检查时报语法错误，但浏览器实际运行正常。原因：

- Node.js 提取的文本保留了 HTML 层的 `\\'`，直接作为 JS 解析
- 浏览器先经过 HTML 属性解析，`\\` → `\`，然后 `\''` → `'`（有效转义）
- 两者解析路径不同，结论不同

**结论**：`node --check` 对内嵌在 HTML 中的脚本的语法检查**不可靠**，应以浏览器实际行为为准。

## 三、解决方案：事件委托

### 3.1 核心思路

**放弃内联 onclick，改用 `data-*` 属性 + 事件委托**：

```html
<!-- 之前（多层转义地狱） -->
<button onclick="showEdit('\\' + esc(s.name) + '\\')">编辑</button>

<!-- 之后（零转义问题） -->
<button data-name="站点名" data-action="show-edit">编辑</button>
```

### 3.2 实现代码

```javascript
// 事件委托：一个监听器处理所有动态按钮
document.addEventListener("click", function(e) {
  var el = e.target.closest("[data-action]");
  if (!el) return;
  var action = el.getAttribute("data-action");
  var name = el.getAttribute("data-name") || "";
  var id = el.getAttribute("data-id") || "";
  switch (action) {
    case "toggle-select":    toggleSelect(name, el.checked); break;
    case "toggle-enable":    toggleEnable(name, el.checked); break;
    case "show-edit":        showEdit(name); break;
    case "delete-site":      deleteSite(name); break;
    case "approve-submission": approveSubmission(id); break;
    case "reject-submission":  rejectSubmission(id); break;
  }
});

// change 事件（checkbox 需要单独监听）
document.addEventListener("change", function(e) {
  var el = e.target.closest("[data-action]");
  if (!el) return;
  var action = el.getAttribute("data-action");
  var name = el.getAttribute("data-name") || "";
  if (action === "toggle-select") toggleSelect(name, el.checked);
  if (action === "toggle-enable") toggleEnable(name, el.checked);
});
```

### 3.3 优势

| 对比项 | 内联 onclick | 事件委托 |
|--------|-------------|---------|
| 转义层级 | 4层（模板→HTML→属性→JS） | 1层（模板→HTML） |
| 动态参数传递 | 需要 `\\\\''` 等复杂转义 | `data-name="xxx"` 直接赋值 |
| 性能 | 每个元素绑定一个处理器 | 一个监听器处理所有 |
| 维护性 | 修改需理解转义链 | 标准 HTML 属性，直观 |
| 调试 | 错误信息指向不可读的转义代码 | 标准 DOM 属性，易调试 |

## 四、关键规则（防止再犯）

### 规则 1：模板字面量中禁止内联 onclick + 动态参数

```javascript
// ❌ 绝对不要这样做
return `<button onclick="fn('${dynamicData}')">`;
// 模板字面量 → HTML → JS 属性 = 3层转义，极易出错

// ✅ 正确做法
return `<button data-value="${esc(dynamicData)}" data-action="fn">`;
// 只有 1 层转义（模板→HTML），且 esc() 处理了引号
```

### 规则 2：esc() 函数必须覆盖所有 HTML 属性危险字符

```javascript
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

### 规则 3：静态 onclick 可以保留（无动态参数）

```javascript
// ✅ 静态 onclick 没有转义问题
<button onclick="doLogin()">登 录</button>
<button onclick="loadSites()">🔄 刷新</button>
```

### 规则 4：不要用 `node --check` 验证内嵌 HTML 的脚本

```bash
# ❌ 不可靠
sed -n '/<script>/,/<\/script>/p' file | node --check

# ✅ 正确验证方式：在浏览器中实际测试
curl -s https://xxx.workers.dev/admin | open -f
# 或直接在浏览器中打开，检查控制台
```

## 五、类似的坑（扩展阅读）

### 5.1 JSON 嵌套在模板字面量中

```javascript
// ❌ 危险：JSON 中的引号可能破坏模板
return `<script>const data = ${JSON.stringify(obj)};</script>`;

// ✅ 安全：用 data 属性传递
return `<div id="root" data='${JSON.stringify(obj)}'></div>`;
<script>
  const data = JSON.parse(document.getElementById("root").dataset.data);
</script>
```

### 5.2 URL 参数中的特殊字符

```javascript
// ❌ 危险：URL 中的 & 可能被 HTML 解析
return `<a href="${url}">`;

// ✅ 安全：esc() 处理所有特殊字符
return `<a href="${esc(url)}">`;
```

## 六、总结

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| `doLogin is not defined` | 整个 script 块语法错误 | 事件委托替代内联 onclick |
| Node.js `--check` 误报 | 提取的脚本与浏览器解析路径不同 | 以浏览器实际行为为准 |
| 模板字面量转义混乱 | 4层转义链太深 | data-* 属性只涉及1层转义 |

**核心教训**：在模板字面量中生成 HTML 时，**永远不要用内联 onclick 传递动态参数**。用 `data-*` 属性 + 事件委托是唯一可靠的方案。
