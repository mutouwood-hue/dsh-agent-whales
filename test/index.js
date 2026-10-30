/**
 * 测试入口汇总。
 *
 * 为什么要这个文件：Node 24 的 `node --test <目录>` 不再把目录展开成用例文件，
 * 而是把目录当模块入口解析；没有 index.js 时会报 MODULE_NOT_FOUND（实测
 * Node v24.21/v24.22）。`test/index.js` 作为目录入口被加载，再把四个用例文件
 * 全部 import 进来，`cd dsh-agent-whales && node --test test/` 因而可用。
 *
 * 等价的显式写法（不做目录解析、不会重复执行）：
 *   node --test "test/*.test.mjs"
 */
import "./client.test.mjs";
import "./index.test.mjs";
import "./client-robustness.test.mjs";
import "./meta.test.mjs";
