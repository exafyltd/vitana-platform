/** VTID-04999: container health check — exit 0 when /alive answers 200. */
import http from 'http';

http.get(`http://127.0.0.1:${process.env.PORT || 8080}/alive`, (res) => process.exit(res.statusCode === 200 ? 0 : 1))
  .on('error', () => process.exit(1))
  .setTimeout(3000, () => process.exit(1));
