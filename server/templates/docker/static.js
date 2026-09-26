/**
 * Static HTML/CSS/JavaScript Dockerfile Generator
 * Serves static web assets with high-performance Alpine Nginx.
 */
export function generateStaticDockerfile(metadata = {}) {
  const { port = 80 } = metadata;

  return `FROM nginx:alpine

WORKDIR /usr/share/nginx/html

COPY . .

EXPOSE ${port || 80}

CMD ["nginx", "-g", "daemon off;"]
`;
}
