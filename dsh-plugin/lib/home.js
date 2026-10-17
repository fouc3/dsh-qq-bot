/**
 * `~` 展开（插件里所有"用户给的路径"共用这一份）。
 *
 * 为什么不用 `process.env.HOME`：Windows 上通常**没有 HOME**（那边是 USERPROFILE），
 * 拿环境变量展开时 `~/.dsh/dsh-qq-bot/bridge.sock` 会保持字面量，
 * 最后在当前目录下建出一个名叫 `~` 的目录——不报错，但所有东西都放错地方。
 * `os.homedir()` 在各平台上都给出正确的家目录（Windows 取 USERPROFILE）。
 *
 * 另：`~\…`（Windows 的写法）也认，展开后按平台分隔符拼。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 把开头的 `~` 换成家目录；不是 `~` 开头的原样返回。 */
export function expandHome(path) {
	if (typeof path !== 'string' || !path) return path
	if (path === '~') return homedir()
	if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
	return path
}
