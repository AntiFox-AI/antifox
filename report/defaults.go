package report

// Default deterministic scaffold content shared by all reports (brand-free,
// neutral), in three locales: zh-CN | zh-TW | en-US. The delivery conventions
// (personnel, PTES process, ~56-item test checklist, tools, standards) are
// fixed; the AI only writes the narrative prose. Company name / personnel are
// user-configured in 报告管理; these are locale-aware fallbacks.
//
// Selector functions (methodologyIntro/methodology/tools/standards/checklist/
// defaultPersonnel) project the requested locale; build.go calls them with the
// report locale.

type kv struct {
	Name string `json:"name"`
	Desc string `json:"desc"`
}

// checklistItem is one row of the 2.3 测试清单 (already localized).
type checklistItem struct {
	Category string `json:"category"`
	Name     string `json:"name"`
	Desc     string `json:"desc"`
}

// ---------------------------------------------------------------------------
// 2.1 测试人员信息 — neutral, brand-free fallbacks (no contact). Overridden by
// user-configured personnel in report settings.
// ---------------------------------------------------------------------------
func defaultPersonnel(loc string) []map[string]string {
	switch normLocale(loc) {
	case "zh-TW":
		return []map[string]string{
			{"name": "專案負責人 / 安全工程師", "role": "專案負責人 / 安全工程師", "contact": ""},
			{"name": "紅隊評估小組", "role": "攻防團隊", "contact": ""},
		}
	case "en-US":
		return []map[string]string{
			{"name": "Lead Consultant / Security Engineer", "role": "Lead Consultant / Security Engineer", "contact": ""},
			{"name": "Red Team Assessment Group", "role": "Offensive Security Team", "contact": ""},
		}
	default:
		return []map[string]string{
			{"name": "项目负责人 / 安全工程师", "role": "项目负责人 / 安全工程师", "contact": ""},
			{"name": "红队评估小组", "role": "攻防团队", "contact": ""},
		}
	}
}

// ---------------------------------------------------------------------------
// 2.2 测试流程 (PTES 8 phases)
// ---------------------------------------------------------------------------
func methodologyIntro(loc string) string {
	return pick(loc,
		"渗透测试服务流程依托于国际公认的渗透测试执行标准 PTES（Penetration Testing Execution Standard），确保每次服务标准化、高质量地进行。流程包含以下 8 个阶段：",
		"滲透測試服務流程依循國際公認的滲透測試執行標準 PTES（Penetration Testing Execution Standard），確保每次服務標準化、高品質地進行。流程包含以下 8 個階段：",
		"The penetration testing service workflow follows the internationally recognized Penetration Testing Execution Standard (PTES), ensuring that every engagement is delivered in a standardized, high-quality manner. The workflow comprises the following 8 phases:")
}

func methodology(loc string) []kv {
	switch normLocale(loc) {
	case "zh-TW":
		return []kv{
			{"前期溝通", "立項準備，雙方協商測試範圍與具體測試項目，完成授權確認及人員、工具準備。"},
			{"資訊收集", "圍繞授權資產進行公開資訊收集、資產測繪與站台結構分析，制定滲透測試實施方案。"},
			{"威脅建模", "分析業務資產與流程，評估威脅對象與能力，識別主要攻擊面與風險路徑。"},
			{"漏洞分析", "結合工具掃描結果進行關聯分析與人工驗證，於受控環境中重現，得出分析結論。"},
			{"滲透攻擊", "依據分析結果選擇最佳攻擊路徑，進行低影響的精準驗證，確認風險真實性。"},
			{"後滲透攻擊", "在授權範圍內評估漏洞遭利用後的橫向移動、權限提升與敏感資料可達性。"},
			{"提交報告", "彙整漏洞詳情、證據、CVSS 評分與風險定級，輸出可交付的滲透測試報告。"},
			{"加固防護", "在報告基礎上配合客戶完成整改，並於需要時開展複測以確認漏洞閉環。"},
		}
	case "en-US":
		return []kv{
			{"Pre-engagement Interactions", "Project initiation and preparation: both parties agree on the testing scope and specific test items, and authorization confirmation, personnel, and tooling are finalized."},
			{"Intelligence Gathering", "Open-source information collection, asset mapping, and site structure analysis around the authorized assets, culminating in the penetration testing implementation plan."},
			{"Threat Modeling", "Analysis of business assets and processes, assessment of threat actors and their capabilities, and identification of the primary attack surface and risk paths."},
			{"Vulnerability Analysis", "Correlation analysis of scanner results combined with manual verification, reproduction in a controlled environment, and derivation of analytical conclusions."},
			{"Exploitation", "Based on the analysis results, the optimal attack path is selected to perform low-impact, precise verification and confirm the authenticity of each risk."},
			{"Post-Exploitation", "Within the authorized scope, assessment of lateral movement, privilege escalation, and reachability of sensitive data following successful exploitation."},
			{"Reporting", "Consolidation of vulnerability details, evidence, CVSS scoring, and risk ratings into a deliverable penetration test report."},
			{"Remediation Support", "Working with the client to complete remediation based on the report, and conducting retesting where required to confirm that vulnerabilities are fully closed."},
		}
	default:
		return []kv{
			{"前期沟通", "立项准备，双方协商测试范围与具体测试项，完成授权确认及人员、工具准备。"},
			{"信息收集", "围绕授权资产开展公开信息收集、资产测绘与站点结构分析，制定渗透测试实施方案。"},
			{"威胁建模", "分析业务资产与流程，评估威胁对象与能力，识别主要攻击面与风险路径。"},
			{"漏洞分析", "结合工具扫描结果进行关联分析与人工验证，在受控环境中复现，得出分析结论。"},
			{"渗透攻击", "根据分析结果选择最佳攻击路径，进行低影响的精准验证，确认风险真实性。"},
			{"后渗透攻击", "在授权范围内评估漏洞被利用后的横向移动、权限提升与敏感数据可达性。"},
			{"提交报告", "整理漏洞详情、证据、CVSS 评分与风险定级，输出可交付的渗透测试报告。"},
			{"加固防护", "在报告基础上配合客户完成整改，并在需要时开展复测以确认漏洞闭环。"},
		}
	}
}

// ---------------------------------------------------------------------------
// 2.4 测试工具
// ---------------------------------------------------------------------------
func tools(loc string) []kv {
	switch normLocale(loc) {
	case "zh-TW":
		return []kv{
			{"Burp Suite", "用於 Web 應用程式安全測試的整合平台，作為本次滲透測試的核心代理與封包擷取工具。"},
			{"SQLMap", "用於偵測與利用 SQL 注入漏洞的開源工具。"},
			{"Nmap", "網路連接埠掃描與服務辨識工具。"},
			{"Nuclei", "基於 YAML 範本的漏洞掃描器，用於批次指紋辨識與漏洞驗證。"},
			{"cURL / httpie", "命令列 HTTP 請求建構與回應分析工具。"},
			{"Wappalyzer / EHole", "Web 應用程式框架與指紋辨識工具。"},
			{"自研 POC 庫", "內部維護的漏洞驗證指令碼庫，搭配本地漏洞庫索引使用。"},
		}
	case "en-US":
		return []kv{
			{"Burp Suite", "An integrated platform for web application security testing, serving as the primary proxy and packet-capture tool for this penetration test."},
			{"SQLMap", "An open-source tool for detecting and exploiting SQL injection vulnerabilities."},
			{"Nmap", "A network port scanning and service identification tool."},
			{"Nuclei", "A YAML-template-based vulnerability scanner used for bulk fingerprinting and vulnerability verification."},
			{"cURL / httpie", "Command-line tools for crafting HTTP requests and analyzing responses."},
			{"Wappalyzer / EHole", "Web application framework and fingerprint identification tools."},
			{"In-house POC Library", "An internally maintained library of vulnerability verification scripts, used together with a local vulnerability database index."},
		}
	default:
		return []kv{
			{"Burp Suite", "用于 Web 应用攻击测试的集成平台，作为本次渗透测试的核心代理与抓包工具。"},
			{"SQLMap", "用于检测与利用 SQL 注入漏洞的开源工具。"},
			{"Nmap", "网络端口扫描与服务识别工具。"},
			{"Nuclei", "基于 YAML 模板的漏洞扫描器，用于批量指纹与漏洞验证。"},
			{"cURL / httpie", "命令行 HTTP 请求构造与响应分析工具。"},
			{"Wappalyzer / EHole", "Web 应用框架与指纹识别工具。"},
			{"自研 POC 库", "内部维护的漏洞验证脚本库，配合本地漏洞库索引使用。"},
		}
	}
}

// ---------------------------------------------------------------------------
// 2.5 参考规范
// ---------------------------------------------------------------------------
func standards(loc string) []string {
	switch normLocale(loc) {
	case "zh-TW":
		return []string{
			"《GB/T 25069-2022 資訊安全技術 術語》",
			"《GB/T 22239-2019 資訊安全技術 網路安全等級保護基本要求》",
			"《GB/T 28448-2019 資訊安全技術 網路安全等級保護測評要求》",
			"《GB/T 20271-2006 資訊安全技術 資訊系統通用安全技術要求》",
			"PTES（Penetration Testing Execution Standard，滲透測試執行標準）",
			"OWASP Top 10：2021",
		}
	case "en-US":
		return []string{
			"GB/T 25069-2022 Information Security Technology — Terminology",
			"GB/T 22239-2019 Information Security Technology — Baseline for Classified Protection of Cybersecurity",
			"GB/T 28448-2019 Information Security Technology — Evaluation Requirements for Classified Protection of Cybersecurity",
			"GB/T 20271-2006 Information Security Technology — Common Security Techniques Requirement for Information Systems",
			"PTES (Penetration Testing Execution Standard)",
			"OWASP Top 10: 2021",
		}
	default:
		return []string{
			"《GB/T 25069-2022 信息安全技术 术语》",
			"《GB/T 22239-2019 信息安全技术 网络安全等级保护基本要求》",
			"《GB/T 28448-2019 信息安全技术 网络安全等级保护测评要求》",
			"《GB/T 20271-2006 信息安全技术 信息系统通用安全技术要求》",
			"PTES（Penetration Testing Execution Standard，渗透测试执行标准）",
			"OWASP Top 10：2021",
		}
	}
}

// ---------------------------------------------------------------------------
// 2.3 测试清单 (~56 items). checklistRow holds all three locales; checklist(loc)
// projects the requested one. AI-returned checklist_hits are matched against the
// localized Name (see buildChecklist) → matched rows render 不通过 (red bold).
// ---------------------------------------------------------------------------
type checklistRow struct {
	CatCN, CatTW, CatEN    string
	NameCN, NameTW, NameEN string
	DescCN, DescTW, DescEN string
}

func checklist(loc string) []checklistItem {
	out := make([]checklistItem, 0, len(checklistAll))
	for _, r := range checklistAll {
		switch normLocale(loc) {
		case "zh-TW":
			out = append(out, checklistItem{Category: r.CatTW, Name: r.NameTW, Desc: r.DescTW})
		case "en-US":
			out = append(out, checklistItem{Category: r.CatEN, Name: r.NameEN, Desc: r.DescEN})
		default:
			out = append(out, checklistItem{Category: r.CatCN, Name: r.NameCN, Desc: r.DescCN})
		}
	}
	return out
}

var checklistAll = []checklistRow{
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "暴力破解", "暴力破解", "Brute Force", "常存在于登录系统中，通过对已知用户名进行登录口令的大量尝试。", "常存在於登入系統中，針對已知使用者名稱進行登入密碼的大量嘗試。", "Commonly found in login systems; large-scale attempts of login credentials against a known username."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "短信轰炸", "簡訊轟炸", "SMS Bombing", "对发送短信验证码功能的数据包重放，造成短信轰炸。", "對傳送簡訊驗證碼功能的封包進行重送，造成簡訊轟炸。", "Replaying the SMS verification-code request to flood a target with text messages (SMS bombing)."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "登录认证绕过", "登入認證繞過", "Authentication Bypass", "应用未使用有效的 token 机制，可修改鉴权信息绕过服务器鉴权。", "應用程式未使用有效的 token 機制，可修改鑑權資訊以繞過伺服器端鑑權。", "The application lacks a valid token mechanism, allowing authentication information to be modified to bypass server-side authorization."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "恶意注册", "惡意註冊", "Malicious Registration", "用户注册功能可被攻击者进行批量注册操作。", "使用者註冊功能可被攻擊者用於批次註冊操作。", "The user registration function can be abused by an attacker to perform bulk registration."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "固定会话攻击", "固定工作階段攻擊", "Session Fixation", "登录前后 session id 未变化，存在会话劫持风险。", "登入前後 session id 未變更，存在工作階段劫持風險。", "The session ID does not change before and after login, creating a session-hijacking risk."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "密码明文传输", "密碼明文傳輸", "Plaintext Password Transmission", "用户名或密码在传输过程中未加密，易被嗅探截取。", "使用者名稱或密碼於傳輸過程中未加密，易遭嗅探攔截。", "Usernames or passwords are transmitted without encryption, making them susceptible to sniffing and interception."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "密码找回逻辑缺陷", "密碼找回邏輯缺陷", "Password Recovery Logic Flaw", "密码找回流程存在逻辑缺陷，可被利用非法重置密码。", "密碼找回流程存在邏輯缺陷，可被利用以非法重設密碼。", "Logic flaws in the password recovery flow can be exploited to illegitimately reset a password."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "OAuth 认证缺陷", "OAuth 認證缺陷", "OAuth Authentication Flaw", "OAuth 认证不完全，可越权登录他人账户。", "OAuth 認證不完整，可越權登入他人帳戶。", "Incomplete OAuth authentication allows unauthorized login to other users' accounts."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "弱口令", "弱密碼", "Weak Password", "通过爆破、猜测等方式发现系统中的弱口令。", "透過爆破、猜測等方式發現系統中的弱密碼。", "Discovery of weak passwords in the system through brute forcing, guessing, and similar techniques."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "失效的身份认证和会话管理", "失效的身分認證與工作階段管理", "Broken Authentication & Session Management", "认证及 session 管理功能出现漏洞、未做超时设置。", "認證及 session 管理功能存在漏洞、未設定逾時。", "Vulnerabilities in the authentication and session management functions, including missing session timeout settings."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "验证码功能缺陷", "驗證碼功能缺陷", "CAPTCHA Functional Flaw", "验证码不失效可重复使用，可进行暴力破解。", "驗證碼不失效且可重複使用，可用於暴力破解。", "The CAPTCHA does not expire and can be reused, enabling brute-force attacks."},
	{"认证与会话管理", "認證與工作階段管理", "Authentication & Session Management", "用户名可枚举", "使用者名稱可列舉", "Username Enumeration", "不同账号返回不同错误信息，可枚举系统中存在的账号。", "不同帳號回傳不同錯誤訊息，可列舉系統中存在的帳號。", "Different accounts return different error messages, allowing enumeration of valid accounts in the system."},
	{"前端安全", "前端安全", "Client-Side Security", "CORS 跨域资源共享漏洞", "CORS 跨來源資源共用漏洞", "CORS Cross-Origin Resource Sharing Vulnerability", "CORS 配置不当，可被利用窃取用户敏感数据。", "CORS 設定不當，可被利用以竊取使用者敏感資料。", "Improper CORS configuration can be exploited to steal users' sensitive data."},
	{"前端安全", "前端安全", "Client-Side Security", "Flash 跨域访问漏洞", "Flash 跨網域存取漏洞", "Flash Cross-Domain Access Vulnerability", "crossdomain.xml 策略不正确导致安全问题。", "crossdomain.xml 政策不正確導致安全問題。", "An incorrect crossdomain.xml policy leads to cross-domain security issues."},
	{"前端安全", "前端安全", "Client-Side Security", "jQuery 版本过低", "jQuery 版本過舊", "Outdated jQuery Version", "jQuery 版本过低，存在跨站等安全漏洞。", "jQuery 版本過舊，存在跨站指令碼等安全漏洞。", "An outdated jQuery version introduces cross-site scripting and other known security vulnerabilities."},
	{"前端安全", "前端安全", "Client-Side Security", "JSONP 劫持", "JSONP 劫持", "JSONP Hijacking", "跨域数据传输未做权限认证，敏感数据可被恶意脚本读取。", "跨網域資料傳輸未進行權限認證，敏感資料可被惡意指令碼讀取。", "Cross-domain data transfer lacks authorization checks, allowing sensitive data to be read by malicious scripts."},
	{"前端安全", "前端安全", "Client-Side Security", "跨站请求伪造（CSRF）", "跨站請求偽造（CSRF）", "Cross-Site Request Forgery (CSRF)", "迫使已认证用户在 Web 应用中执行非预期操作。", "迫使已認證的使用者在 Web 應用程式中執行非預期的操作。", "Forces an authenticated user to perform unintended actions within a web application."},
	{"前端安全", "前端安全", "Client-Side Security", "跨站脚本攻击（XSS）", "跨站指令碼攻擊（XSS）", "Cross-Site Scripting (XSS)", "向 Web 页面注入恶意脚本，浏览时执行恶意代码。", "向 Web 頁面注入惡意指令碼，瀏覽時執行惡意程式碼。", "Injects malicious scripts into web pages, executing malicious code when the page is viewed."},
	{"恶意输入", "惡意輸入 / 注入", "Malicious Input / Injection", "代码注入", "程式碼注入", "Code Injection", "攻击者提交代码作为输入，被服务器当作动态代码处理。", "攻擊者提交程式碼作為輸入，被伺服器當作動態程式碼處理。", "An attacker submits code as input, which the server processes as dynamic code."},
	{"恶意输入", "惡意輸入 / 注入", "Malicious Input / Injection", "LDAP 注入", "LDAP 注入", "LDAP Injection", "通过 LDAP 查询语法泄露用户和主机敏感信息。", "透過 LDAP 查詢語法洩漏使用者與主機的敏感資訊。", "Leverages LDAP query syntax to disclose sensitive user and host information."},
	{"恶意输入", "惡意輸入 / 注入", "Malicious Input / Injection", "命令注入", "命令注入", "Command Injection", "通过 HTTP 请求注入 OS 命令，在服务器执行系统命令。", "透過 HTTP 請求注入作業系統命令，於伺服器執行系統命令。", "Injects OS commands via an HTTP request to execute system commands on the server."},
	{"恶意输入", "惡意輸入 / 注入", "Malicious Input / Injection", "XFF 注入", "XFF 注入", "XFF Injection", "通过修改 X-Forwarded-For 头进行 SQL 注入。", "透過竄改 X-Forwarded-For 標頭進行 SQL 注入。", "Performs SQL injection by manipulating the X-Forwarded-For header."},
	{"恶意输入", "惡意輸入 / 注入", "Malicious Input / Injection", "SSI 注入", "SSI 注入", "SSI Injection", "可能注入代码至 HTML 页甚至远程代码执行。", "可能將程式碼注入 HTML 頁面，甚至導致遠端程式碼執行。", "May allow injection of code into HTML pages and even remote code execution."},
	{"恶意输入", "惡意輸入 / 注入", "Malicious Input / Injection", "SQL 注入", "SQL 注入", "SQL Injection", "通过插入 SQL 查询，可获取/篡改数据、执行管理操作或系统命令。", "透過插入 SQL 查詢，可讀取／竄改資料、執行管理操作或系統命令。", "By inserting SQL queries, an attacker can read or tamper with data, perform administrative operations, or execute system commands."},
	{"恶意输入", "惡意輸入 / 注入", "Malicious Input / Injection", "XPath 注入", "XPath 注入", "XPath Injection", "在 XPath 查询中注入元素，可能绕过认证。", "在 XPath 查詢中注入元素，可能繞過認證。", "Injects elements into an XPath query, potentially bypassing authentication."},
	{"恶意输入", "惡意輸入 / 注入", "Malicious Input / Injection", "链接或框架注入漏洞", "連結或框架注入漏洞", "Link or Frame Injection", "注入含恶意内容的 frame 或 iframe 标记。", "注入含有惡意內容的 frame 或 iframe 標記。", "Injects frame or iframe tags containing malicious content."},
	{"恶意输入", "惡意輸入 / 注入", "Malicious Input / Injection", "XML 外部实体注入", "XML 外部實體注入", "XML External Entity (XXE) Injection", "XML 外部实体可用于读取系统文件、SSRF 等攻击。", "XML 外部實體可用於讀取系統檔案、SSRF 等攻擊。", "XML external entities can be abused to read system files, perform SSRF, and mount other attacks."},
	{"访问控制", "存取控制", "Access Control", "本地文件包含", "本地檔案包含", "Local File Inclusion", "包含目标服务器上的代码执行，获取敏感文件或权限。", "包含並執行目標伺服器上的程式碼，以取得敏感檔案或權限。", "Includes and executes code on the target server to obtain sensitive files or privileges."},
	{"访问控制", "存取控制", "Access Control", "垂直越权访问", "垂直越權存取", "Vertical Privilege Escalation", "低权限账号可访问或操作高权限功能。", "低權限帳號可存取或操作高權限功能。", "A low-privilege account can access or operate high-privilege functionality."},
	{"访问控制", "存取控制", "Access Control", "未授权访问", "未授權存取", "Unauthorized Access", "未登录或未授权情况下直接访问内部资源或功能。", "在未登入或未授權的情況下直接存取內部資源或功能。", "Internal resources or functions can be accessed directly without login or authorization."},
	{"访问控制", "存取控制", "Access Control", "任意文件上传", "任意檔案上傳", "Arbitrary File Upload", "上传可执行脚本文件并获得执行服务器命令能力。", "上傳可執行的指令碼檔案，進而取得執行伺服器命令的能力。", "Uploading an executable script file to gain the ability to run commands on the server."},
	{"访问控制", "存取控制", "Access Control", "任意文件下载", "任意檔案下載", "Arbitrary File Download", "可任意浏览或下载系统文件、配置文件等。", "可任意瀏覽或下載系統檔案、設定檔等。", "System files, configuration files, and similar can be browsed or downloaded arbitrarily."},
	{"访问控制", "存取控制", "Access Control", "水平越权访问", "水平越權存取", "Horizontal Privilege Escalation", "同权限用户之间可访问或操作其他用户资源。", "相同權限的使用者之間可存取或操作其他使用者的資源。", "Users at the same privilege level can access or operate other users' resources."},
	{"访问控制", "存取控制", "Access Control", "远程文件包含", "遠端檔案包含", "Remote File Inclusion", "通过构造参数包含远程代码在服务器执行。", "透過建構參數包含遠端程式碼並於伺服器執行。", "Crafting parameters to include remote code that is executed on the server."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "报错页面信息泄漏", "錯誤頁面資訊洩漏", "Error Page Information Disclosure", "报错信息中包含敏感的服务器或数据库信息。", "錯誤訊息中包含敏感的伺服器或資料庫資訊。", "Error messages contain sensitive server or database information."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "测试、备份文件泄露", "測試、備份檔案洩漏", "Test / Backup File Leak", "遗留的过时文件、备份页面、测试文件等泄露。", "遺留的過時檔案、備份頁面、測試檔案等遭洩漏。", "Leftover outdated files, backup pages, and test files are exposed."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", ".git 源码泄漏", ".git 原始碼洩漏", ".git Source Code Leak", "发布时未删除 .git 目录，可恢复源代码。", "發布時未刪除 .git 目錄，可還原原始碼。", "The .git directory was not removed at deployment, allowing source code to be recovered."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "GitHub 信息泄露", "GitHub 資訊洩漏", "GitHub Information Leak", "敏感代码、密钥等被无意公开至 GitHub。", "敏感程式碼、金鑰等被無意公開至 GitHub。", "Sensitive code, keys, and similar are inadvertently made public on GitHub."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "IIS 短文件名泄露", "IIS 短檔名洩漏", "IIS Short Filename Disclosure", "IIS 文件枚举漏洞，可枚举根目录中的文件。", "IIS 檔案列舉漏洞，可列舉根目錄中的檔案。", "An IIS file enumeration vulnerability that allows enumeration of files in the root directory."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "绝对路径泄漏", "絕對路徑洩漏", "Absolute Path Disclosure", "应用中泄露出在主机中的绝对路径。", "應用程式洩漏其在主機上的絕對路徑。", "The application discloses its absolute path on the host."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "列目录", "目錄列表", "Directory Listing", "网站配置缺陷导致存在目录可浏览漏洞。", "網站設定缺陷導致存在可瀏覽目錄的漏洞。", "A website configuration flaw results in a browsable directory listing vulnerability."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "敏感信息泄露", "敏感資訊洩漏", "Sensitive Information Disclosure", "配置文件包含口令、密钥、内部地址、员工标识等敏感数据。", "設定檔包含密碼、金鑰、內部位址、員工識別碼等敏感資料。", "Configuration files contain sensitive data such as passwords, keys, internal addresses, and employee identifiers."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "敏感文件泄露", "敏感檔案洩漏", "Sensitive File Leak", "程序文件、配置文件、日志、备份及数据库文件泄漏。", "程式檔案、設定檔、日誌、備份及資料庫檔案遭洩漏。", "Program files, configuration files, logs, backups, and database files are exposed."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "默认页面泄漏", "預設頁面洩漏", "Default Page Leak", "默认安装的中间件、框架携带示例页面及说明文档。", "預設安裝的中介軟體、框架附帶範例頁面及說明文件。", "Default-installed middleware and frameworks ship with sample pages and documentation."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "目录遍历", "目錄遍歷", "Directory Traversal", "攻击者查看网站目录结构及文件，发动进一步攻击。", "攻擊者檢視網站目錄結構及檔案，以發動進一步攻擊。", "An attacker views the website's directory structure and files to mount further attacks."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "入侵痕迹残留", "入侵痕跡殘留", "Residual Intrusion Traces", "应用中存在曾经的入侵痕迹，如 WebShell 文件。", "應用程式中存在先前的入侵痕跡，如 WebShell 檔案。", "Traces of a prior intrusion remain in the application, such as WebShell files."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "SVN 源码泄露", "SVN 原始碼洩漏", "SVN Source Code Leak", "通过 SVN 源码泄露漏洞获得源代码。", "透過 SVN 原始碼洩漏漏洞取得原始碼。", "Source code is obtained through an SVN source code disclosure vulnerability."},
	{"信息泄露", "資訊洩漏", "Information Disclosure", "Web 控制台泄漏", "Web 主控台洩漏", "Web Console Exposure", "泄漏 Web 容器或数据库的控制台。", "洩漏 Web 容器或資料庫的主控台。", "The management console of a web container or database is exposed."},
	{"配置错误", "設定錯誤", "Security Misconfiguration", "不安全的 HTTP 请求方法", "不安全的 HTTP 請求方法", "Insecure HTTP Methods", "服务端启用 TRACE/PUT/DELETE 等不安全方法。", "伺服器端啟用 TRACE／PUT／DELETE 等不安全的方法。", "The server enables insecure methods such as TRACE, PUT, and DELETE."},
	{"配置错误", "設定錯誤", "Security Misconfiguration", "服务端请求伪造（SSRF）", "伺服器端請求偽造（SSRF）", "Server-Side Request Forgery (SSRF)", "服务端代为发起请求，可访问内网或本地资源。", "伺服器端代為發起請求，可存取內網或本機資源。", "The server makes requests on the attacker's behalf, allowing access to internal-network or local resources."},
	{"配置错误", "設定錯誤", "Security Misconfiguration", "Host 头攻击", "Host 標頭攻擊", "Host Header Attack", "恶意利用 HTTP Host header 造成钓鱼、缓存投毒等。", "惡意利用 HTTP Host 標頭造成釣魚、快取污染等攻擊。", "Malicious manipulation of the HTTP Host header to enable phishing, cache poisoning, and similar attacks."},
	{"配置错误", "設定錯誤", "Security Misconfiguration", "慢速 HTTP DoS 攻击", "慢速 HTTP DoS 攻擊", "Slow HTTP DoS Attack", "通过慢速请求耗尽服务器资源。", "透過慢速請求耗盡伺服器資源。", "Exhausts server resources through slow HTTP requests."},
	{"配置错误", "設定錯誤", "Security Misconfiguration", "Web 服务器多余端口开放", "Web 伺服器多餘連接埠開放", "Unnecessary Web Server Ports Open", "除业务端口外开放一些默认端口。", "除業務連接埠外，另開放了一些預設連接埠。", "Default ports beyond the required business ports are left open."},
	{"存储与传输不安全", "儲存與傳輸不安全", "Insecure Storage & Transport", "不安全的存储方式", "不安全的儲存方式", "Insecure Storage", "对重要信息不加密或加密强度不够。", "對重要資訊未加密或加密強度不足。", "Important information is not encrypted or is encrypted with insufficient strength."},
	{"存储与传输不安全", "儲存與傳輸不安全", "Insecure Storage & Transport", "HTML 中的敏感信息", "HTML 中的敏感資訊", "Sensitive Information in HTML", "HTML 页面中含有敏感信息。", "HTML 頁面中含有敏感資訊。", "HTML pages contain sensitive information."},
}
