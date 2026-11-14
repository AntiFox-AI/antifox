---
name: incident-response
description: Professional skills and methodology for security incident response
version: 1.0.0
---

# Security Incident Response

## Overview

Security incident response is a critical process for handling security incidents. This skill provides methods, tools, and best practices for responding to security incidents.

## Response Process

### 1. Preparation Phase

**Preparation work:**
- Establish a response team
- Develop a response plan
- Prepare tools and resources
- Set up communication channels

### 2. Identification Phase

**Identify incidents:**
- Monitor alerts
- Anomaly detection
- Log analysis
- User reports

### 3. Containment Phase

**Containment measures:**
- Isolate affected systems
- Disable accounts
- Block network connections
- Back up evidence

### 4. Eradication Phase

**Eliminate threats:**
- Remove malware
- Patch vulnerabilities
- Reset credentials
- Clean up backdoors

### 5. Recovery Phase

**Restore systems:**
- Restore from backups
- Verify system integrity
- Monitor systems
- Restore services gradually

### 6. Lessons Learned Phase

**Summarize lessons:**
- Incident report
- Lessons learned
- Improvement measures
- Update processes

## Tool Usage

### Log Analysis

**Using Splunk:**
```bash
# 搜索日志
index=security event_type="failed_login"

# 统计分析
index=security | stats count by src_ip

# 时间序列分析
index=security | timechart count by event_type
```

**Using ELK:**
```bash
# Elasticsearch查询
GET /logs/_search
{
  "query": {
    "match": {
      "event_type": "malware"
    }
  }
}
```

### Forensic Tools

**Using Volatility:**
```bash
# 分析内存镜像
volatility -f memory.dump imageinfo

# 列出进程
volatility -f memory.dump --profile=Win7SP1x64 pslist

# 提取进程内存
volatility -f memory.dump --profile=Win7SP1x64 memdump -p 1234 -D output/
```

**Using Autopsy:**
```bash
# 启动Autopsy
# 创建案例
# 添加证据
# 分析数据
```

### Network Analysis

**Using Wireshark:**
```bash
# 捕获流量
wireshark -i eth0

# 分析PCAP文件
wireshark -r capture.pcap

# 过滤流量
# 显示过滤器: ip.addr == 192.168.1.100
# 捕获过滤器: host 192.168.1.100
```

**Using tcpdump:**
```bash
# 捕获流量
tcpdump -i eth0 -w capture.pcap

# 分析流量
tcpdump -r capture.pcap -A
```

## Incident Types

### Malware

**Response steps:**
1. Isolate affected systems
2. Collect samples
3. Analyze the malware
4. Eradicate the threat
5. Patch vulnerabilities

**Tools:**
- VirusTotal
- Cuckoo Sandbox
- YARA rules

### Data Breach

**Response steps:**
1. Confirm the scope of the breach
2. Contain the breach
3. Assess the impact
4. Notify relevant parties
5. Patch vulnerabilities

**Items to check:**
- Volume of leaked data
- Affected users
- Breach channel
- Data sensitivity

### Denial of Service

**Response steps:**
1. Confirm the attack type
2. Enable protective measures
3. Filter malicious traffic
4. Monitor system status
5. Restore normal service

**Protective measures:**
- DDoS protection services
- Traffic scrubbing
- Rate limiting
- CDN protection

### Unauthorized Access

**Response steps:**
1. Disable affected accounts
2. Reset credentials
3. Review access logs
4. Assess data access
5. Patch vulnerabilities

**Items to check:**
- Access times
- Content accessed
- Access origin
- Data modifications

## Response Checklist

### Preparation Phase
- [ ] Establish a response team
- [ ] Develop a response plan
- [ ] Prepare tools
- [ ] Set up communication channels

### Identification Phase
- [ ] Confirm the incident
- [ ] Collect information
- [ ] Assess the impact
- [ ] Record the timeline

### Containment Phase
- [ ] Isolate systems
- [ ] Disable accounts
- [ ] Block connections
- [ ] Back up evidence

### Eradication Phase
- [ ] Remove threats
- [ ] Patch vulnerabilities
- [ ] Reset credentials
- [ ] Verify eradication

### Recovery Phase
- [ ] Restore systems
- [ ] Verify integrity
- [ ] Monitor systems
- [ ] Restore services

### Lessons Learned Phase
- [ ] Write the report
- [ ] Summarize lessons
- [ ] Improve measures
- [ ] Update processes

## Best Practices

### 1. Preparation

- Establish a response team
- Develop a response plan
- Conduct regular drills
- Prepare tools

### 2. Response

- Respond quickly
- Handle systematically
- Document all actions
- Protect evidence

### 3. Communication

- Internal communication
- External notifications
- Status updates
- Post-incident report

### 4. Improvement

- Incident analysis
- Process improvement
- Tool updates
- Training enhancement

## Key Considerations

- Respond quickly
- Protect evidence
- Document actions
- Comply with laws and regulations
