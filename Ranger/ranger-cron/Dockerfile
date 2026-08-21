FROM alpine:latest
RUN apk add --no-cache curl
COPY trigger.sh /trigger.sh
RUN chmod +x /trigger.sh
CMD ["/trigger.sh"]
