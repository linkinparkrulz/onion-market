FROM alpine:3.21
RUN apk add --no-cache tor su-exec
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
