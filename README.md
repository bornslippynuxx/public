demo

change_alb_host_routing() {
    ALB_ARN=$1
    OLD_HOST=$2
    NEW_HOST=$3

    LISTENER_ARN=$(aws elbv2 describe-listeners --load-balancer-arn $ALB_ARN --query "Listeners[?Port==443].ListenerArn" --output text)
    
    if [ -z "$LISTENER_ARN" ]; then
        echo "No listener found on port 443 for ALB: $ALB_ARN"
        return 1
    fi

    RULE_ARN=$(aws elbv2 describe-rules --listener-arn $LISTENER_ARN --query "Rules[?Conditions[?Field=='host-header' && contains(Values, '$OLD_HOST')]].RuleArn" --output text)
    
    if [ -z "$RULE_ARN" ]; then
        echo "No rule found with host condition: $OLD_HOST"
        return 1
    fi

    aws elbv2 modify-rule \
        --rule-arn $RULE_ARN \
        --conditions Field=host-header,Values=$NEW_HOST
}
