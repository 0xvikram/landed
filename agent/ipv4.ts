// HSP QA allowlists one IPv4 address (the laptop's). Its host also answers on IPv6, and Node would
// otherwise try IPv6 first, so force every outgoing connection from this process onto IPv4.
import dns from "node:dns";
import net from "node:net";

dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(false);
