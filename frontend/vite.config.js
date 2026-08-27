import { defineConfig } from 'vite';
import { resolve } from 'path';

// ═══════════════════════════════════════════════════════════════════════════════
// broadcast-watch plugin — 修复 Step 0 定时炸弹：开发模式下自动同步 broadcast/*.js → main.js
//
// 背景：main.js 是 broadcast/*.js 的拼接产物。生产构建已通过
// package.json 的 build 脚本保证拼接，但开发模式（vite）直接读取
// src/main.js，如果修改了 broadcast/*.js 忘记手动跑 concat，开发服务器
// 会 silently  serving 旧代码——正是文档 17 点名的"双份真相"根因。
//
// 本插件在开发服务器启动时监听 src/broadcast/ 目录，任何变更都自动
// 触发 concat-broadcast.mjs 重新生成 main.js，并通知 Vite HMR 更新。
// ═══════════════════════════════════════════════════════════════════════════════
function broadcastWatchPlugin() {
  return {
    name: 'broadcast-watch',
    configureServer(server) {
      const broadcastDir = resolve(__dirname, 'src/broadcast');
      // broadcast/*.js 不在 Vite 模块依赖图里，必须显式加入 watcher
      server.watcher.add(broadcastDir);

      let timeout;
      server.watcher.on('all', (event, path) => {
        if (path.startsWith(broadcastDir) && (event === 'change' || event === 'add')) {
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            console.log(`\n[broadcast-watch] detected ${event} in ${path}, regenerating main.js...`);
            try {
              const { execSync } = require('child_process');
              execSync('node scripts/concat-broadcast.mjs', {
                cwd: resolve(__dirname),
                stdio: 'inherit',
              });
              // concat 已写入 main.js，Vite watcher 会检测到并触发 HMR
            } catch (e) {
              console.error('[broadcast-watch] concat failed:', e.message);
            }
          }, 50);
        }
      });
    },
  };
}

export default defineConfig({
  root: '.',
  base: '/_app/',
  plugins: [broadcastWatchPlugin()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8799',
        changeOrigin: true,
      },
    },
  },
});
