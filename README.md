demo

```
#!/bin/bash

modify_alb_host_header() {
    local load_balancer_arn="$1"
    local old_subdomain="$2"
    local new_subdomain="$3"
    
    if [ $# -ne 3 ]; then
        echo "Usage: modify_alb_host_header <load_balancer_arn> <old_subdomain> <new_subdomain>"
        echo "Example: modify_alb_host_header arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/1234567890123456 api staging"
        return 1
    fi
    
    # Get the listener ARN for port 443
    local listener_arn=$(aws elbv2 describe-listeners \
        --load-balancer-arn "$load_balancer_arn" \
        --query "Listeners[?Port==\`443\`].ListenerArn" \
        --output text)
    
    if [ -z "$listener_arn" ]; then
        echo "Error: No listener found on port 443 for the specified load balancer"
        return 1
    fi
    
    # Find the rule with the matching host header
    local rule_arn=$(aws elbv2 describe-rules \
        --listener-arn "$listener_arn" \
        --query "Rules[?Conditions[?Field==\`host-header\` && Values[?starts_with(@, \`$old_subdomain.\`)]] | [0].RuleArn" \
        --output text)
    
    if [ -z "$rule_arn" ] || [ "$rule_arn" = "None" ]; then
        echo "Error: No rule found with host-header starting with '$old_subdomain.'"
        return 1
    fi
    
    # Get the current host header value
    local current_host=$(aws elbv2 describe-rules \
        --rule-arns "$rule_arn" \
        --query "Rules[0].Conditions[?Field==\`host-header\`].Values[0]" \
        --output text)
    
    # Replace the subdomain
    local new_host=$(echo "$current_host" | sed "s/^$old_subdomain\./$new_subdomain\./")
    
    echo "Modifying rule: $current_host -> $new_host"
    
    # Modify only the host-header condition
    aws elbv2 modify-rule \
        --rule-arn "$rule_arn" \
        --conditions Field=host-header,Values="$new_host"
    
    if [ $? -eq 0 ]; then
        echo "Successfully modified ALB rule from '$current_host' to '$new_host'"
    else
        echo "Error: Failed to modify ALB rule"
        return 1
    fi
}
```
