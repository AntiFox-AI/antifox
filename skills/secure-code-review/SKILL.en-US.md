---
name: secure-code-review
description: Professional skills and methodology for secure code review
version: 1.0.0
---

# Secure Code Review

## Overview

Secure code review is an important method for identifying security vulnerabilities in code. This skill provides the methods, tools, and best practices for secure code review.

## Review Scope

### 1. Input Validation

**Checklist items:**
- User input validation
- Parameter validation
- Data filtering
- Boundary checks

### 2. Output Encoding

**Checklist items:**
- XSS protection
- Output encoding
- Content Security Policy
- Response header configuration

### 3. Authentication and Authorization

**Checklist items:**
- Authentication mechanisms
- Session management
- Access control
- Password handling

### 4. Cryptography and Keys

**Checklist items:**
- Data encryption
- Key management
- Hash algorithms
- Random number generation

## Review Methods

### 1. Static Analysis

**Using SAST tools:**
```bash
# SonarQube
sonar-scanner

# Checkmarx
# Use the web interface

# Fortify
sourceanalyzer -b project build.sh
sourceanalyzer -b project -scan

# Semgrep
semgrep --config=auto .
```

### 2. Manual Review

**Review checklist:**
- [ ] Input validation
- [ ] Output encoding
- [ ] SQL injection
- [ ] XSS vulnerabilities
- [ ] Authentication and authorization
- [ ] Cryptographic usage
- [ ] Error handling
- [ ] Logging

### 3. Code Pattern Recognition

**Dangerous functions:**
```python
# Python dangerous functions
eval()
exec()
pickle.loads()
os.system()
subprocess.call()
```

```java
// Java dangerous functions
Runtime.exec()
ProcessBuilder()
Class.forName()
```

```php
// PHP dangerous functions
eval()
exec()
system()
passthru()
```

## Common Vulnerability Patterns

### SQL Injection

**Vulnerable code:**
```java
String query = "SELECT * FROM users WHERE id = " + userId;
Statement stmt = connection.createStatement();
ResultSet rs = stmt.executeQuery(query);
```

**Secure code:**
```java
String query = "SELECT * FROM users WHERE id = ?";
PreparedStatement stmt = connection.prepareStatement(query);
stmt.setInt(1, userId);
ResultSet rs = stmt.executeQuery();
```

### XSS Vulnerabilities

**Vulnerable code:**
```javascript
document.innerHTML = userInput;
element.innerHTML = "<div>" + userInput + "</div>";
```

**Secure code:**
```javascript
element.textContent = userInput;
element.setAttribute("data-value", userInput);
// or use an encoding library
element.innerHTML = escapeHtml(userInput);
```

### Command Injection

**Vulnerable code:**
```python
import os
os.system("ping " + user_input)
```

**Secure code:**
```python
import subprocess
subprocess.run(["ping", "-c", "1", validated_input])
```

### Path Traversal

**Vulnerable code:**
```java
String filePath = "/uploads/" + fileName;
File file = new File(filePath);
```

**Secure code:**
```java
String basePath = "/uploads/";
String fileName = Paths.get(fileName).getFileName().toString();
String filePath = basePath + fileName;
File file = new File(filePath);
if (!file.getCanonicalPath().startsWith(basePath)) {
    throw new SecurityException("Invalid path");
}
```

### Hardcoded Secrets

**Vulnerable code:**
```java
String apiKey = "1234567890abcdef";
String password = "admin123";
```

**Secure code:**
```java
String apiKey = System.getenv("API_KEY");
String password = keyStore.getPassword("db_password");
```

## Tool Usage

### SonarQube

```bash
# Start SonarQube
docker run -d -p 9000:9000 sonarqube

# Run a scan
sonar-scanner \
  -Dsonar.projectKey=myproject \
  -Dsonar.sources=. \
  -Dsonar.host.url=http://localhost:9000
```

### Semgrep

```bash
# Install
pip install semgrep

# Run a scan
semgrep --config=auto .

# Use rules
semgrep --config=p/security-audit .
```

### CodeQL

```bash
# Create a database
codeql database create database --language=java --source-root=.

# Run queries
codeql database analyze database security-and-quality.qls --format=sarif-latest
```

## Review Checklist

### Input Validation
- [ ] All user input is validated
- [ ] Whitelist-based validation is used
- [ ] Data types and ranges are validated
- [ ] Special characters are handled

### Output Encoding
- [ ] HTML output encoding
- [ ] URL encoding
- [ ] JavaScript encoding
- [ ] SQL parameterization

### Authentication and Authorization
- [ ] Strong password policy
- [ ] Secure session management
- [ ] Authorization checks
- [ ] Multi-factor authentication

### Cryptography
- [ ] Strong encryption algorithms used
- [ ] Keys stored securely
- [ ] Encryption in transit
- [ ] Encryption at rest

### Error Handling
- [ ] No sensitive information disclosed
- [ ] Uniform error responses
- [ ] Errors logged
- [ ] Exception handling

## Best Practices

### 1. Secure Coding Standards

- Follow OWASP Top 10
- Use secure coding guidelines
- Code review process
- Security training

### 2. Automation Tools

- Integrate SAST tools
- CI/CD security checks
- Automated scanning
- Result analysis

### 3. Code Review Process

- Peer review
- Security expert review
- Periodic reviews
- Issue documentation

## Notes

- Combine tools with manual review
- Pay attention to business logic vulnerabilities
- Update tool rules regularly
- Build a secure coding culture
