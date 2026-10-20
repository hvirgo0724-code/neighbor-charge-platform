INSERT INTO communities (id, name, address) VALUES
('C001','阳光花园社区','北京市朝阳区望京')
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address;
INSERT INTO charging_piles (id, community_id, code, status, power, faults, last_seen) VALUES
('P001','C001','A区-01','available',7,0,now()),
('P002','C001','A区-02','charging',7,0,now()),
('P003','C001','A区-03','fault',0,3,now()),
('P004','C001','B区-01','available',11,1,now())
ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, power=EXCLUDED.power, faults=EXCLUDED.faults, last_seen=EXCLUDED.last_seen;
INSERT INTO charging_orders (id, user_id, pile_id, status, amount, kwh, created_at) VALUES
('O001','U004','P002','charging',6.80,4.20,now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO repair_tickets (id, pile_id, level, title, status, created_at) VALUES
('T001','P003','P1','A区-03 连续充电中断','open',now())
ON CONFLICT (id) DO NOTHING;
