/**
 * Host 半边：**空壳**。
 *
 * 这个 bundle 要的东西全在浏览器里（会话标题栏右上角那个「ID」按钮），所以 Host 侧
 * 不需要任何 Service、Tool 或监听——`apply()` 什么都不做，只负责让这一行存在于 profile
 * 里，从而让 `dsh.client` 声明的浏览器模块被加载。
 *
 * 为什么 host 半边也要有文件：bundle 的一行就是一个 Host 插件入口（`main`/`exports["."]`），
 * Client 半边是它的附加物（`exports["./client"]` + `dsh.client`），两者同属一个包。
 */

export function apply() {}
