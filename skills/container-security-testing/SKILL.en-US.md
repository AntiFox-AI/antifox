---
name: container-security-testing
description: Professional skills and methodology for container security testing
version: 1.0.0
---

# Container Security Testing

## Overview

Container security testing is a critical part of ensuring the security of containerized applications. This skill provides methods, tools, and best practices for container security testing, covering container technologies such as Docker and Kubernetes.

## Testing Scope

### 1. Image Security

**Checklist items:**
- Base image vulnerabilities
- Dependency package vulnerabilities
- Image configuration
- Sensitive information

### 2. Runtime Security

**Checklist items:**
- Container privileges
- Resource limits
- Network isolation
- File system

### 3. Orchestration Security

**Checklist items:**
- Kubernetes configuration
- Service accounts
- RBAC
- Network policies

## Docker Security Testing

### Image Scanning

**Using Trivy:**
```bash
# 扫描镜像
trivy image nginx:latest

# 扫描本地镜像
trivy image --input nginx.tar

# 只显示高危漏洞
trivy image --severity HIGH,CRITICAL nginx:latest
```

**Using Clair:**
```bash
# 启动Clair
docker run -d --name clair clair:latest

# 扫描镜像
clair-scanner --ip 192.168.1.100 nginx:latest
```

**Using Docker Bench:**
```bash
# 运行Docker安全基准测试
docker run --rm --net host --pid host --userns host --cap-add audit_control \
  -e DOCKER_CONTENT_TRUST=$DOCKER_CONTENT_TRUST \
  -v /etc:/etc:ro \
  -v /usr/bin/containerd:/usr/bin/containerd:ro \
  -v /usr/bin/runc:/usr/bin/runc:ro \
  -v /usr/lib/systemd:/usr/lib/systemd:ro \
  -v /var/lib:/var/lib:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --label docker_bench_security \
  docker/docker-bench-security
```

### Container Configuration Review

**Reviewing the Dockerfile:**
```dockerfile
# 安全问题示例
FROM ubuntu:latest  # 使用latest标签
RUN apt-get update && apt-get install -y curl  # 未指定版本
COPY . /app  # 可能包含敏感文件
ENV PASSWORD=secret  # 硬编码密码
USER root  # 使用root用户
```

**Security best practices:**
```dockerfile
# 使用特定版本
FROM ubuntu:20.04

# 指定包版本
RUN apt-get update && apt-get install -y curl=7.68.0-1ubuntu2.7

# 使用非root用户
RUN useradd -m appuser
USER appuser

# 最小化镜像
FROM alpine:3.15

# 多阶段构建
FROM golang:1.18 AS builder
WORKDIR /app
COPY . .
RUN go build -o app

FROM alpine:3.15
COPY --from=builder /app/app /app
```

### Runtime Checks

**Checking container privileges:**
```bash
# 检查特权容器
docker ps --filter "label=privileged=true"

# 检查挂载的主机目录
docker inspect container_name | grep -A 10 Mounts

# 检查容器网络
docker network inspect network_name
```

**Checking resource limits:**
```bash
# 检查内存限制
docker stats container_name

# 检查CPU限制
docker inspect container_name | grep -i cpu
```

## Kubernetes Security Testing

### Configuration Review

**Using kube-bench:**
```bash
# 运行kube-bench
kube-bench run

# 检查特定基准
kube-bench run --targets master,node,etcd
```

**Using kube-hunter:**
```bash
# 运行kube-hunter
kube-hunter --remote target-ip

# 主动模式
kube-hunter --active
```

### Pod Security

**Checking Pod Security Policies:**
```yaml
# 不安全的Pod配置
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    image: nginx
    securityContext:
      privileged: true  # 特权模式
      runAsUser: 0  # root用户
```

**Secure configuration:**
```yaml
apiVersion: v1
kind: Pod
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 2000
  containers:
  - name: app
    image: nginx
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
        add:
        - NET_BIND_SERVICE
```

### RBAC Review

**Checking role permissions:**
```bash
# 列出所有角色
kubectl get roles --all-namespaces

# 检查角色绑定
kubectl get rolebindings --all-namespaces

# 检查集群角色
kubectl get clusterroles

# 检查用户权限
kubectl auth can-i --list --as=system:serviceaccount:default:sa-name
```

**Common issues:**
- Excessive privileges
- Unused roles
- Unused service accounts

### Network Policies

**Checking network policies:**
```bash
# 列出所有网络策略
kubectl get networkpolicies --all-namespaces

# 检查网络策略配置
kubectl describe networkpolicy policy-name -n namespace
```

**Network policy example:**
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

## Tool Usage

### Falco

**Runtime security monitoring:**
```bash
# 安装Falco
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm install falco falcosecurity/falco

# 检查规则
falco -r /etc/falco/rules.d/
```

### Aqua Security

```bash
# 扫描镜像
aqua image scan nginx:latest

# 扫描Kubernetes集群
aqua k8s scan
```

### Snyk

```bash
# 扫描Dockerfile
snyk test --docker nginx:latest

# 扫描Kubernetes配置
snyk iac test k8s/
```

## Testing Checklist

### Image Security
- [ ] Scan base image for vulnerabilities
- [ ] Scan dependency packages for vulnerabilities
- [ ] Review Dockerfile configuration
- [ ] Check for sensitive information leakage

### Runtime Security
- [ ] Check container privileges
- [ ] Check resource limits
- [ ] Check network isolation
- [ ] Check file system mounts

### Orchestration Security
- [ ] Review Kubernetes configuration
- [ ] Review RBAC configuration
- [ ] Review network policies
- [ ] Review Pod Security Policies

## Common Security Issues

### 1. Image Vulnerabilities

**Issues:**
- Base image contains vulnerabilities
- Dependency packages contain vulnerabilities
- Not updated in a timely manner

**Remediation:**
- Scan images regularly
- Update base images promptly
- Use minimal images

### 2. Excessive Privileges

**Issues:**
- Container runs as root
- Privileged mode
- Sensitive directories mounted

**Remediation:**
- Use a non-root user
- Disable privileged mode
- Restrict file system access

### 3. Misconfiguration

**Issues:**
- Insecure default configuration
- Missing network policies
- Incorrect RBAC configuration

**Remediation:**
- Follow security best practices
- Implement network policies
- Configure RBAC correctly

### 4. Sensitive Information Leakage

**Issues:**
- Image contains secrets/keys
- Environment variables exposed
- Configuration files leaked

**Remediation:**
- Use secret management
- Avoid hardcoding
- Use Secret objects

## Best Practices

### 1. Image Security

- Use official base images
- Update images regularly
- Scan images for vulnerabilities
- Minimize image size

### 2. Runtime Security

- Use a non-root user
- Restrict container privileges
- Enforce resource limits
- Enable security contexts

### 3. Orchestration Security

- Configure network policies
- Implement RBAC
- Use Pod Security Policies
- Enable audit logging

## Important Notes

- Only test in authorized environments
- Avoid impacting production environments
- Be aware of differences between container platforms
- Perform security scans regularly
