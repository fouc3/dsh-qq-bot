package qq

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// md5OfFirstBytes 是平台要求额外提供的"前 10MB 校验和"覆盖的字节数。
const md5OfFirstBytes = 10002432

// 各类型的软上限（平台文档值）；超过软上限平台会降级为文件，超过硬上限直接失败。
const (
	imageSoftLimit = 20 << 20
	videoSoftLimit = 30 << 20
	audioSoftLimit = 20 << 20
	fileSoftLimit  = 200 << 20
)

// MediaKind 是富媒体类型。
type MediaKind string

// 支持的富媒体类型。
const (
	MediaImage MediaKind = "image"
	MediaVideo MediaKind = "video"
	MediaVoice MediaKind = "voice"
	MediaFile  MediaKind = "file"
)

func (k MediaKind) fileType() (int, error) {
	switch k {
	case MediaImage:
		return qqbotsdk.FileTypeImage, nil
	case MediaVideo:
		return qqbotsdk.FileTypeVideo, nil
	case MediaVoice:
		return qqbotsdk.FileTypeAudio, nil
	case MediaFile:
		return qqbotsdk.FileTypeFile, nil
	default:
		return 0, fmt.Errorf("不支持的类型 %q（可选 image/video/voice/file）", string(k))
	}
}

func (k MediaKind) softLimit() int64 {
	switch k {
	case MediaImage:
		return imageSoftLimit
	case MediaVideo:
		return videoSoftLimit
	case MediaVoice:
		return audioSoftLimit
	default:
		return fileSoftLimit
	}
}

// MediaConfig 是富媒体发送策略（来自配置）。
type MediaConfig struct {
	// MaxUploadBytes 是单个文件的硬上限（平台硬上限 200MB）。
	MaxUploadBytes int64
	// AllowedRoots 为空表示不限制本机路径。
	AllowedRoots []string
	// UploadConcurrency 为 0 表示用平台返回的 UploadConfig.concurrency。
	UploadConcurrency int
}

// MediaRequest 是一条富媒体消息。
type MediaRequest struct {
	OpenID string
	Kind   MediaKind
	// Path 是本机文件路径（走分片上传），与 URL 二选一。
	Path string
	// URL 是公网可下载地址（平台自己下载），与 Path 二选一。
	URL string
	// Name 是展示用的文件名，可空。
	Name           string
	ReplyToMsgID   string
	ReplyToEventID string
	MsgSeq         int
}

// SendMedia 上传并发送一条富媒体单聊消息。
//
// 两条上传路径：公网 URL 直接交给平台下载；本机文件按平台要求走
// 「预上传 → 分片 PUT → 上报分片 → 合并」四步（SDK 不含分片 PUT）。
func (c *Client) SendMedia(ctx context.Context, req MediaRequest, cfg MediaConfig) (*qqbotsdk.MessageResponse, error) {
	if strings.TrimSpace(req.OpenID) == "" {
		return nil, errors.New("qq: 缺少单聊 openid")
	}
	fileType, err := req.Kind.fileType()
	if err != nil {
		return nil, err
	}
	if (req.Path == "") == (req.URL == "") {
		return nil, errors.New("qq: 富媒体需要且只能给 path 或 url 之一")
	}

	var fileInfo string
	switch {
	case req.URL != "":
		resp, err := c.api.UploadC2CFile(ctx, req.OpenID, &qqbotsdk.FileUploadRequest{
			FileType: fileType,
			URL:      req.URL,
			FileName: req.Name,
		})
		if err != nil {
			return nil, fmt.Errorf("按 URL 上传富媒体失败：%w", err)
		}
		if resp == nil || resp.FileInfo == "" {
			return nil, errors.New("上传未返回 file_info")
		}
		fileInfo = resp.FileInfo
	default:
		info, err := c.uploadLocalFile(ctx, req.OpenID, req.Path, fileType, req.Kind, cfg)
		if err != nil {
			return nil, err
		}
		fileInfo = info
	}

	msg := &qqbotsdk.Message{
		MsgType: qqbotsdk.MsgTypeMedia,
		Media:   &qqbotsdk.MediaInfo{FileInfo: fileInfo},
		MsgID:   req.ReplyToMsgID,
		EventID: req.ReplyToEventID,
		MsgSeq:  req.MsgSeq,
	}
	return c.sendWithFallback(ctx, req.OpenID, msg)
}

// uploadLocalFile 上传本机文件，返回 file_info。
func (c *Client) uploadLocalFile(ctx context.Context, openid, path string, fileType int, kind MediaKind, cfg MediaConfig) (string, error) {
	absPath, err := c.checkLocalFile(path, kind, cfg)
	if err != nil {
		return "", err
	}

	sums, err := fileChecksums(absPath)
	if err != nil {
		return "", err
	}
	fileName := filepath.Base(absPath)

	prep, err := c.api.PrepareC2CUpload(ctx, openid, &qqbotsdk.UploadPrepareRequest{
		FileType:      fileType,
		FileSize:      strconv.FormatInt(sums.size, 10),
		FileName:      fileName,
		MD5:           sums.md5,
		SHA1:          sums.sha1,
		MD5OfFirst10M: sums.md5OfFirst10M,
	})
	if err != nil {
		return "", fmt.Errorf("预上传失败：%w", err)
	}
	if prep == nil || prep.UploadID == "" {
		return "", errors.New("预上传未返回 upload_id")
	}
	if len(prep.Parts) == 0 {
		return "", errors.New("预上传未返回分片列表")
	}

	file, err := os.Open(absPath)
	if err != nil {
		return "", fmt.Errorf("打开待上传文件失败：%w", err)
	}
	defer file.Close()

	concurrency := cfg.UploadConcurrency
	if concurrency <= 0 {
		concurrency = prep.UploadConfig.Concurrency
	}
	if concurrency <= 0 {
		concurrency = 1
	}
	if concurrency > len(prep.Parts) {
		concurrency = len(prep.Parts)
	}

	attempts := 3
	if prep.UploadConfig.RetryDelay > 0 && prep.UploadConfig.RetryTimeout > 0 {
		// 平台给了重试策略就用它的窗口：次数按窗口/间隔推算，至少 2 次。
		attempts = prep.UploadConfig.RetryTimeout / prep.UploadConfig.RetryDelay
		if attempts < 2 {
			attempts = 2
		}
		if attempts > 10 {
			attempts = 10
		}
	}
	delay := time.Second
	if prep.UploadConfig.RetryDelay > 0 {
		delay = time.Duration(prep.UploadConfig.RetryDelay) * time.Second
	}

	segments, err := partSegments(prep.Parts, sums.size)
	if err != nil {
		return "", err
	}

	sem := make(chan struct{}, concurrency)
	errCh := make(chan error, len(prep.Parts))
	var wg sync.WaitGroup
	for i, part := range prep.Parts {
		seg := segments[i]
		if seg.size <= 0 {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(part qqbotsdk.UploadPart, seg partSegment) {
			defer wg.Done()
			defer func() { <-sem }()

			buf := make([]byte, seg.size)
			if _, err := file.ReadAt(buf, seg.offset); err != nil && !errors.Is(err, io.EOF) {
				errCh <- fmt.Errorf("读取分片 %d 失败：%w", part.Index, err)
				return
			}
			if err := c.putPart(ctx, part.PresignedURL, buf, attempts, delay); err != nil {
				errCh <- fmt.Errorf("上传分片 %d 失败：%w", part.Index, err)
				return
			}
			sum := md5.Sum(buf)
			if err := c.api.FinishC2CUploadPart(ctx, openid, &qqbotsdk.UploadPartFinishRequest{
				UploadID:  prep.UploadID,
				PartIndex: part.Index,
				BlockSize: strconv.FormatInt(seg.size, 10),
				MD5:       hex.EncodeToString(sum[:]),
			}); err != nil {
				errCh <- fmt.Errorf("上报分片 %d 完成失败：%w", part.Index, err)
			}
		}(part, seg)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			return "", err
		}
	}

	resp, err := c.api.UploadC2CFile(ctx, openid, &qqbotsdk.FileUploadRequest{
		FileType: fileType,
		UploadID: prep.UploadID,
		FileName: fileName,
	})
	if err != nil {
		return "", fmt.Errorf("合并分片失败：%w", err)
	}
	if resp == nil || resp.FileInfo == "" {
		return "", errors.New("合并分片未返回 file_info")
	}
	return resp.FileInfo, nil
}

// checkLocalFile 做本地校验：路径允许、是普通文件、大小不超限。
func (c *Client) checkLocalFile(path string, kind MediaKind, cfg MediaConfig) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("qq: 富媒体缺少 path")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("解析路径失败：%w", err)
	}
	if !withinRoots(abs, cfg.AllowedRoots) {
		return "", fmt.Errorf("路径不在允许的根目录内：%s", abs)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("读取文件失败：%w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("不能发送目录：%s", abs)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("只能发送普通文件：%s", abs)
	}
	size := info.Size()
	if size == 0 {
		return "", fmt.Errorf("文件为空：%s", abs)
	}
	limit := cfg.MaxUploadBytes
	if limit <= 0 || limit > fileSoftLimit {
		limit = fileSoftLimit
	}
	if soft := kind.softLimit(); soft < limit {
		limit = soft
	}
	if size > limit {
		return "", fmt.Errorf("%s 类型单文件上限 %d 字节，当前 %d 字节（%s）", kind, limit, size, abs)
	}
	if kind == MediaImage {
		switch strings.ToLower(filepath.Ext(abs)) {
		case ".png", ".jpg", ".jpeg":
		default:
			c.log.Warn("图片类型不是 png/jpg，平台可能降级为文件", "path", abs)
		}
	}
	return abs, nil
}

// putPart 把一片字节 PUT 到预签名地址，4xx 不重试、5xx/网络错误退避重试。
func (c *Client) putPart(ctx context.Context, url string, data []byte, attempts int, delay time.Duration) error {
	if attempts < 1 {
		attempts = 1
	}
	client := c.PutClient
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}

	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(data))
		if err != nil {
			return err
		}
		req.ContentLength = int64(len(data))
		req.Header.Set("Content-Type", "application/octet-stream")

		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
		} else {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil
			}
			lastErr = fmt.Errorf("分片 PUT 返回 %d：%s", resp.StatusCode, strings.TrimSpace(string(body)))
			if resp.StatusCode < 500 && resp.StatusCode != http.StatusTooManyRequests {
				return lastErr
			}
		}
		if attempt == attempts {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return lastErr
}

// partSegment 是一个分片在文件里的位置。
type partSegment struct {
	offset int64
	size   int64
}

// partSegments 按平台给出的分片表算出每片的偏移与长度（末片可能更短）。
func partSegments(parts []qqbotsdk.UploadPart, totalSize int64) ([]partSegment, error) {
	out := make([]partSegment, len(parts))
	offset := int64(0)
	for i, part := range parts {
		blockSize, err := strconv.ParseInt(strings.TrimSpace(part.BlockSize), 10, 64)
		if err != nil || blockSize <= 0 {
			return nil, fmt.Errorf("分片 %d 的 block_size 非法：%q", part.Index, part.BlockSize)
		}
		size := blockSize
		if offset+size > totalSize {
			size = totalSize - offset
		}
		if size < 0 {
			size = 0
		}
		out[i] = partSegment{offset: offset, size: size}
		offset += size
	}
	return out, nil
}

// checksums 是平台预上传要求的三个校验和与文件大小。
type checksums struct {
	size          int64
	md5           string
	sha1          string
	md5OfFirst10M string
}

func fileChecksums(path string) (checksums, error) {
	file, err := os.Open(path)
	if err != nil {
		return checksums{}, fmt.Errorf("打开文件失败：%w", err)
	}
	defer file.Close()

	full := md5.New()
	sha := sha1.New()
	size, err := io.Copy(io.MultiWriter(full, sha), file)
	if err != nil {
		return checksums{}, fmt.Errorf("读取文件失败：%w", err)
	}

	first := md5.New()
	head := make([]byte, md5OfFirstBytes)
	n, err := file.ReadAt(head, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return checksums{}, fmt.Errorf("读取文件头部失败：%w", err)
	}
	if _, err := first.Write(head[:n]); err != nil {
		return checksums{}, err
	}

	return checksums{
		size:          size,
		md5:           hex.EncodeToString(full.Sum(nil)),
		sha1:          hex.EncodeToString(sha.Sum(nil)),
		md5OfFirst10M: hex.EncodeToString(first.Sum(nil)),
	}, nil
}

func withinRoots(path string, roots []string) bool {
	if len(roots) == 0 {
		return true
	}
	for _, root := range roots {
		if strings.TrimSpace(root) == "" {
			continue
		}
		absRoot, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(absRoot, path)
		if err != nil {
			continue
		}
		if rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)) {
			return true
		}
	}
	return false
}
