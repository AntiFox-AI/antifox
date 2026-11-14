---
name: cloud-security-audit
description: Professional skills and methodology for cloud security auditing
version: 1.0.0
---

# Cloud Security Audit

## Overview

Cloud security auditing is a critical part of assessing the security of cloud environments. This skill provides methods, tools, and best practices for cloud security auditing, covering mainstream cloud platforms such as AWS, Azure, and GCP.

## Audit Scope

### 1. Identity and Access Management

**Check items:**
- IAM policy configuration
- User permissions
- Role permissions
- Access key management

### 2. Network Security

**Check items:**
- Security group configuration
- Network ACLs
- VPC configuration
- Traffic encryption

### 3. Data Security

**Check items:**
- Data encryption
- Key management
- Backup policies
- Data classification

### 4. Compliance

**Check items:**
- Compliance frameworks
- Audit logs
- Monitoring and alerting
- Incident response

## AWS Security Audit

### IAM Audit

**Check IAM policies:**
```bash
# List all IAM users
aws iam list-users

# List all IAM policies
aws iam list-policies

# Check user permissions
aws iam list-user-policies --user-name username
aws iam list-attached-user-policies --user-name username

# Check role permissions
aws iam list-role-policies --role-name rolename
```

**Common issues:**
- Excessive permissions
- Unused access keys
- Weak password policies
- MFA not enabled

### S3 Security Audit

**Check S3 buckets:**
```bash
# List all buckets
aws s3 ls

# Check the bucket policy
aws s3api get-bucket-policy --bucket bucketname

# Check the bucket ACL
aws s3api get-bucket-acl --bucket bucketname

# Check bucket encryption
aws s3api get-bucket-encryption --bucket bucketname
```

**Common issues:**
- Public access
- Not encrypted
- Versioning not enabled
- Logging not enabled

### Security Group Audit

**Check security groups:**
```bash
# List all security groups
aws ec2 describe-security-groups

# Check open ports
aws ec2 describe-security-groups --group-ids sg-xxx
```

**Common issues:**
- Open to 0.0.0.0/0
- Unnecessary open ports
- Overly permissive rules

### CloudTrail Audit

**Check audit logs:**
```bash
# List all trails
aws cloudtrail describe-trails

# Check log file integrity
aws cloudtrail get-trail-status --name trailname
```

## Azure Security Audit

### Subscriptions and Resource Groups

**Check subscriptions:**
```bash
# List all subscriptions
az account list

# Check resource groups
az group list
```

### Network Security Groups

**Check NSGs:**
```bash
# List all NSGs
az network nsg list

# Check NSG rules
az network nsg rule list --nsg-name nsgname --resource-group rgname
```

### Storage Accounts

**Check storage accounts:**
```bash
# List all storage accounts
az storage account list

# Check access policies
az storage account show --name accountname --resource-group rgname
```

## GCP Security Audit

### Projects and Organizations

**Check projects:**
```bash
# List all projects
gcloud projects list

# Check IAM policies
gcloud projects get-iam-policy project-id
```

### Compute Engine

**Check instances:**
```bash
# List all instances
gcloud compute instances list

# Check firewall rules
gcloud compute firewall-rules list
```

### Storage

**Check buckets:**
```bash
# List all buckets
gsutil ls

# Check bucket permissions
gsutil iam get gs://bucketname
```

## Automation Tools

### Scout Suite

```bash
# AWS audit
scout aws

# Azure audit
scout azure

# GCP audit
scout gcp
```

### Prowler

```bash
# AWS security audit
prowler -c check11,check12,check13

# Full audit
prowler
```

### CloudSploit

```bash
# Scan an AWS account
cloudsploit scan aws

# Scan an Azure subscription
cloudsploit scan azure
```

### Pacu

```bash
# AWS penetration testing framework
pacu
```

## Audit Checklist

### IAM Security
- [ ] Check user permissions
- [ ] Check role permissions
- [ ] Check access keys
- [ ] Check password policies
- [ ] Check MFA enablement

### Network Security
- [ ] Check security group/NSG rules
- [ ] Check VPC configuration
- [ ] Check network ACLs
- [ ] Check traffic encryption

### Data Security
- [ ] Check data encryption
- [ ] Check key management
- [ ] Check backup policies
- [ ] Check data classification

### Compliance
- [ ] Check audit logs
- [ ] Check monitoring and alerting
- [ ] Check incident response
- [ ] Check compliance frameworks

## Common Security Issues

### 1. Excessive Permissions

**Problem:**
- IAM policies that are too permissive
- Users with administrator privileges
- Roles with overly broad permissions

**Fixes:**
- Principle of least privilege
- Regular permission reviews
- Use IAM policy simulation

### 2. Publicly Exposed Resources

**Problem:**
- Public S3 buckets
- Security groups open to 0.0.0.0/0
- Publicly accessible databases

**Fixes:**
- Restrict access scope
- Use private networks
- Enable access controls

### 3. Unencrypted Data

**Problem:**
- Unencrypted storage
- Unencrypted transit
- Improper key management

**Fixes:**
- Enable encryption
- Use TLS/SSL
- Use key management services

### 4. Missing Logs

**Problem:**
- Audit logging not enabled
- Logs not retained
- Logs not monitored

**Fixes:**
- Enable CloudTrail/Azure Monitor
- Set log retention policies
- Configure monitoring and alerting

## Best Practices

### 1. Least Privilege

- Grant only necessary permissions
- Review permissions regularly
- Use IAM policy simulation

### 2. Defense in Depth

- Network layer protection
- Application layer protection
- Data layer protection

### 3. Monitoring and Alerting

- Enable audit logging
- Configure monitoring and alerting
- Establish an incident response process

### 4. Compliance

- Follow compliance frameworks
- Conduct regular security audits
- Document security policies

## Precautions

- Only audit in authorized environments
- Avoid impacting production environments
- Be mindful of differences between cloud platforms
- Conduct security audits regularly
