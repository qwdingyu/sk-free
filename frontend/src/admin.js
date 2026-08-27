// 管理后台入口
// 全部逻辑在 admin-raw.js：模块求值时完成事件绑定与本地 token 自动登录
// （type="module" 脚本本身延迟到 DOM 解析完成后执行，无需再包 DOMContentLoaded）
import "./admin-raw.js";
