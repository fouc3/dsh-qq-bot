module github.com/fouc3/dsh-qq-bot

go 1.27.1

require gopkg.in/yaml.v3 v3.0.1

// 本机开发用本地 SDK 实体（同机目录）。切回发布版：
//
//	go mod edit -dropreplace=github.com/fouc3/qq-bot-sdk
//	go get github.com/fouc3/qq-bot-sdk@main
replace github.com/fouc3/qq-bot-sdk => ../QQ-Bot-CLI/qq-bot-sdk
