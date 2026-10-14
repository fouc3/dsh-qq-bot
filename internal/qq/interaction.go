package qq

import (
	"context"
	"fmt"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// Recall 撤回一条单聊消息。
//
// 平台限制：超过 2 分钟的普通消息不能撤回（ErrRecallTimeExceeded 40064004）。
// 调用方（出站命令执行器）把撤回当尽力而为：失败只记 WARN，不阻塞后续发送。
func (c *Client) Recall(ctx context.Context, openid, messageID string) error {
	if openid == "" || messageID == "" {
		return fmt.Errorf("qq: 撤回需要 openid 与 message_id")
	}
	if err := c.api.RecallC2CMessage(ctx, openid, messageID); err != nil {
		if qqbotsdk.IsOpenAPIError(err, qqbotsdk.ErrRecallTimeExceeded) {
			return fmt.Errorf("超过撤回时限（2 分钟）：%w", err)
		}
		return err
	}
	return nil
}

// Respond 回应一次按钮互动。
//
// 平台规则：同一个 interaction_id 只应回应一次（客户端在 code=0 后让按钮进终态，
// 服务端对重复回应也不报错）。这里用进程内记忆兜住重复调用。
func (c *Client) Respond(ctx context.Context, interactionID string, code qqbotsdk.InteractionCode) error {
	if interactionID == "" {
		return fmt.Errorf("qq: 回应互动需要 interaction_id")
	}
	if !c.answered.add(interactionID) {
		c.log.Warn("同一互动已被回应过，跳过", "interaction", interactionID)
		return nil
	}
	if err := c.api.RespondInteraction(ctx, interactionID, code); err != nil {
		return fmt.Errorf("回应互动失败（code=%d）：%w", int(code), err)
	}
	return nil
}
