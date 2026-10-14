package executor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Dedupe 记住最近成功执行过的命令 id。
//
// 通道是至少一次投递（60 秒未 ack 会重投），所以必须能识别"这条已经做过了"，
// 否则一次网络抖动就会让用户收到两条一样的消息。记录在**成功之后**写入：
// 执行中崩溃导致的重复无法完全避免（这是 at-least-once 的固有代价），
// 但成功过的命令绝不会再发一次。
type Dedupe struct {
	mu    sync.Mutex
	path  string
	limit int
	ids   []string
	seen  map[string]struct{}
}

// OpenDedupe 打开（或新建）去重记录文件。
func OpenDedupe(path string, limit int) (*Dedupe, error) {
	if limit <= 0 {
		limit = 512
	}
	d := &Dedupe{
		path:  path,
		limit: limit,
		ids:   make([]string, 0, limit),
		seen:  make(map[string]struct{}, limit),
	}
	if path == "" {
		return d, nil
	}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		var stored struct {
			IDs []string `json:"ids"`
		}
		if err := json.Unmarshal(raw, &stored); err != nil {
			return nil, fmt.Errorf("解析去重文件 %s 失败：%w", path, err)
		}
		for _, id := range stored.IDs {
			if id == "" {
				continue
			}
			d.add(id)
		}
	case os.IsNotExist(err):
		// 首次运行
	default:
		return nil, fmt.Errorf("读取去重文件 %s 失败：%w", path, err)
	}
	return d, nil
}

// Seen 报告该命令是否已经成功执行过。
func (d *Dedupe) Seen(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.seen[id]
	return ok
}

// Mark 记录一条已成功执行的命令并落盘。
func (d *Dedupe) Mark(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[id]; ok {
		return nil
	}
	d.add(id)
	return d.flushLocked()
}

// add 仅在持锁时调用。
func (d *Dedupe) add(id string) {
	if len(d.ids) >= d.limit {
		oldest := d.ids[0]
		d.ids = d.ids[1:]
		delete(d.seen, oldest)
	}
	d.ids = append(d.ids, id)
	d.seen[id] = struct{}{}
}

// flushLocked 原子写回磁盘（临时文件 + rename，权限 0600）。
func (d *Dedupe) flushLocked() error {
	if d.path == "" {
		return nil
	}
	raw, err := json.Marshal(struct {
		IDs []string `json:"ids"`
	}{IDs: d.ids})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(d.path), 0o700); err != nil {
		return err
	}
	tmp := d.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.path)
}
