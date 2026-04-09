/**
 * Pre-seeded sanctions list data to avoid indexing from the beginning of time.
 */

import type { Address, Hex } from "viem";

export type SanctionsListSeedData = {
	lastUpdatedBlock: bigint;
	events: {
		blockNumber: bigint;
		transactionHash: Hex;
		eventName: "SanctionedAddressesAdded" | "SanctionedAddressesRemoved";
		args: { addrs: Address[] };
	}[];
};

export const SANCTIONS_LIST_SEED_DATA = {
	"1:0x40C57923924B5c5c5455c48D93317139ADDaC8fb": {
		lastUpdatedBlock: 24841000n,
		events: [
			{
				blockNumber: 14356555n,
				transactionHash: "0x1d3d64b26cfdaeb328d01d09b407f3a806d3254109e4476461b3960592eae902",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x19Aa5Fe80D33a56D56c78e82eA5E50E5d80b4Dff",
						"0x1da5821544e25c636c1417Ba96Ade4Cf6D2f9B5A",
						"0x2f389cE8bD8ff92De3402FFCe4691d17fC4f6535",
						"0x308eD4B7b49797e1A98D3818bFF6fe5385410370",
						"0x3CBdeD43EFdAf0FC77b9C55F6fC9988fCC9b757d",
						"0x48549A34AE37b12F6a30566245176994e17C6b4A",
						"0x5512d943eD1f7c8a43F3435C85F7aB68b30121b0",
						"0x67d40EE1A85bf4a4Bb7Ffae16De985e8427B6b45",
						"0x6aCDFBA02D390b97Ac2b2d42A63E85293BCc160e",
						"0x6F1cA141A28907F78Ebaa64fb83A9088b02A8352",
						"0x72a5843cc08275C8171E582972Aa4fDa8C397B2A",
						"0x7Db418b5D567A4e0E8c59Ad71BE1FcE48f3E6107",
						"0x7F19720A857F834887FC9A7bC0a0fBe7Fc7f8102",
						"0x7F367cC41522cE07553e823bf3be79A889DEbe1B",
						"0x8576aCC5C05D6Ce88f4e49bf65BdF0C62F91353C",
						"0x901bb9583b24D97e995513C6778dc6888AB6870e",
						"0x9F4cda013E354b8fC285BF4b9A60460cEe7f7Ea9",
						"0xA7e5d5A720f06526557c513402f2e6B5fA20b008",
						"0xC455f7fd3e0e12afd51fba5c106909934D8A0e4a",
						"0xd882cFc20F52f2599D84b8e8D58C7FB62cfE344b",
						"0xe7aa314c77F4233C18C6CC84384A9247c0cf367B",
						"0xfEC8A60023265364D066a1212fDE3930F6Ae8da7",
					],
				},
			},
			{
				blockNumber: 14527954n,
				transactionHash: "0xe3c89f573682122446749d87286096bbe66f3efccde1480f58e61ce4273726fa",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x7FF9cFad3877F21d41Da833E2F775dB0569eE3D9"],
				},
			},
			{
				blockNumber: 14584749n,
				transactionHash: "0xf7da9ad1dc31c0a5ad771ee8ef93f36ec9b4edce6e6cbc273b0e900ebe898800",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x098B716B8Aaf21512996dC57EB0615e2383E2f96"],
				},
			},
			{
				blockNumber: 14637076n,
				transactionHash: "0x05aa41b16c7a863e5497ab9bf3273154ac7fdb80370035d624e32198e2e1277f",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xa0e1c89Ef1a489c9C7dE96311eD5Ce5D32c20E4B",
						"0x3Cffd56B47B7b41c56258D9C7731ABaDc360E073",
						"0x53b6936513e738f44FB50d2b9476730C0Ab3Bfc1",
					],
				},
			},
			{
				blockNumber: 14724006n,
				transactionHash: "0xc9d7b45c94a5b78e940c98d1f25818788decaa583042f229f97a9cea194d5e18",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x35fB6f6DB4fb05e6A4cE86f2C93691425626d4b1",
						"0xF7B31119c2682c88d88D455dBb9d5932c65Cf1bE",
						"0x3e37627dEAA754090fBFbb8bd226c1CE66D255e9",
						"0x08723392Ed15743cc38513C4925f5e6be5c17243",
					],
				},
			},
			{
				blockNumber: 15302392n,
				transactionHash: "0x9e4adac535ea92cd81ef33a9571629dd8ab2ca1a0042c3f21a2e3e76901791b1",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x8589427373D6D84E98730D7795D8f6f8731FDA16",
						"0x722122dF12D4e14e13Ac3b6895a86e84145b6967",
						"0xDD4c48C0B24039969fC16D1cdF626eaB821d3384",
						"0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b",
						"0xd96f2B1c14Db8458374d9Aca76E26c3D18364307",
						"0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa9D",
						"0xD4B88Df4D29F5CedD6857912842cff3b20C8Cfa3",
						"0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF",
						"0xA160cdAB225685dA1d56aa342Ad8841c3b53f291",
						"0xFD8610d20aA15b7B2E3Be39B396a1bC3516c7144",
						"0xF60dD140cFf0706bAE9Cd734Ac3ae76AD9eBC32A",
						"0x22aaA7720ddd5388A3c0A3333430953C68f1849b",
						"0xBA214C1c1928a32Bffe790263E38B4Af9bFCD659",
						"0xb1C8094B234DcE6e03f10a5b673c1d8C69739A00",
						"0x527653eA119F3E6a1F5BD18fbF4714081D7B31ce",
						"0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2",
						"0xD691F27f38B395864Ea86CfC7253969B409c362d",
						"0xaEaaC358560e11f52454D997AAFF2c5731B6f8a6",
						"0x1356c899D8C9467C7f71C195612F8A395aBf2f0a",
						"0xA60C772958a3eD56c1F15dD055bA37AC8e523a0D",
						"0x169AD27A470D064DEDE56a2D3ff727986b15D52B",
						"0x0836222F2B2B24A3F36f98668Ed8F0B38D1a872f",
						"0xF67721A2D8F736E75a49FdD7FAd2e31D8676542a",
						"0x9AD122c22B14202B4490eDAf288FDb3C7cb3ff5E",
						"0x905b63Fff465B9fFBF41DeA908CEb12478ec7601",
						"0x07687e702b410Fa43f4cB4Af7FA097918ffD2730",
						"0x94A1B5CdB22c43faab4AbEb5c74999895464Ddaf",
						"0xb541fc07bC7619fD4062A54d96268525cBC6FfEF",
						"0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc",
						"0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936",
						"0x23773E65ed146A459791799d01336DB287f25334",
						"0xD21be7248e0197Ee08E0c20D4a96DEBdaC3D20Af",
						"0x610B717796ad172B316836AC95a2ffad065CeaB4",
						"0x178169B423a011fff22B9e3F3abeA13414dDD0F1",
						"0xbB93e510BbCD0B7beb5A853875f9eC60275CF498",
						"0x2717c5e28cf931547B621a5dddb772Ab6A35B701",
						"0x03893a7c7463AE47D46bc7f091665f1893656003",
						"0xCa0840578f57fE71599D29375e16783424023357",
						"0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2",
						"0x8589427373D6D84E98730D7795D8f6f8731FDA16",
						"0x722122dF12D4e14e13Ac3b6895a86e84145b6967",
						"0xDD4c48C0B24039969fC16D1cdF626eaB821d3384",
						"0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b",
						"0xd96f2B1c14Db8458374d9Aca76E26c3D18364307",
						"0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa9D",
					],
				},
			},
			{
				blockNumber: 15542818n,
				transactionHash: "0xfc6b06392e8e1431e2c9d987b0fda7bc5c8a4e2e4b99ec986174d6935f822f6b",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xc2a3829F459B3Edd87791c74cD45402BA0a20Be3",
						"0x3AD9dB589d201A710Ed237c829c7860Ba86510Fc",
					],
				},
			},
			{
				blockNumber: 15928251n,
				transactionHash: "0xb3754ca28e49008e869da4495a196b974e5a3bdce5ca05deaff1737f606d5bdb",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
						"0xd47438C816c9E7f2E2888E060936a499Af9582b3",
					],
				},
			},
			{
				blockNumber: 15928263n,
				transactionHash: "0x3bae678feffd8a95e96df42b7eec557e9c390373d2929a2f2214fb5bb603206c",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD"],
				},
			},
			{
				blockNumber: 15934045n,
				transactionHash: "0x421b8ea7301bec4cad40a13f5ff288f61bd21c57c9bf4a21258d8b0974a94490",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x83E5bC4Ffa856BB84Bb88581f5Dd62A433A25e0D",
						"0x08b2eFdcdB8822EfE5ad0Eae55517cf5DC544251",
						"0x04DBA1194ee10112fE6C3207C0687DEf0e78baCf",
						"0x0Ee5067b06776A89CcC7dC8Ee369984AD7Db5e06",
						"0x502371699497d08D5339c870851898D6D72521Dd",
						"0x5A14E72060c11313E38738009254a90968F58f51",
						"0xEFE301d259F525cA1ba74A7977b80D5b060B3ccA",
					],
				},
			},
			{
				blockNumber: 15934045n,
				transactionHash: "0x17ed5a4113a651cc2306314ddaea276d08f37268a49232b94b7a0d17f60486eb",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x83E5bC4Ffa856BB84Bb88581f5Dd62A433A25e0D",
						"0x08b2eFdcdB8822EfE5ad0Eae55517cf5DC544251",
						"0x04DBA1194ee10112fE6C3207C0687DEf0e78baCf",
						"0x0Ee5067b06776A89CcC7dC8Ee369984AD7Db5e06",
						"0x502371699497d08D5339c870851898D6D72521Dd",
						"0x5A14E72060c11313E38738009254a90968F58f51",
						"0xEFE301d259F525cA1ba74A7977b80D5b060B3ccA",
					],
				},
			},
			{
				blockNumber: 15934045n,
				transactionHash: "0x42e0c20aa1607afab649fe4834c2c96ae205c67196f138f281234028d494ac98",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x83E5bC4Ffa856BB84Bb88581f5Dd62A433A25e0D",
						"0x08b2eFdcdB8822EfE5ad0Eae55517cf5DC544251",
						"0x04DBA1194ee10112fE6C3207C0687DEf0e78baCf",
						"0x0Ee5067b06776A89CcC7dC8Ee369984AD7Db5e06",
						"0x502371699497d08D5339c870851898D6D72521Dd",
						"0x5A14E72060c11313E38738009254a90968F58f51",
						"0xEFE301d259F525cA1ba74A7977b80D5b060B3ccA",
					],
				},
			},
			{
				blockNumber: 15934045n,
				transactionHash: "0xe99daa5bf045919eb74f79e7f1831c00016d380e8749e7d07d5f0299a0ab7833",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x83E5bC4Ffa856BB84Bb88581f5Dd62A433A25e0D"],
				},
			},
			{
				blockNumber: 15934045n,
				transactionHash: "0x97f990a89bce879cacfb196a54737bad8a0cb3136cde6eca283890ceb2fe4a51",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x08b2eFdcdB8822EfE5ad0Eae55517cf5DC544251"],
				},
			},
			{
				blockNumber: 15934048n,
				transactionHash: "0x2f938ecf08677602bd4cd2b7d43da934f839fea746cb3c8e95ed135efb7a4258",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x83E5bC4Ffa856BB84Bb88581f5Dd62A433A25e0D"],
				},
			},
			{
				blockNumber: 15934050n,
				transactionHash: "0x15882c6f3ea8d9be435385b6a37e633e0b6381eb6c3a71d3f72d8271ec8638ea",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0xD0975B32cEa532eaDDdFC9c60481976e39dB3472"],
				},
			},
			{
				blockNumber: 15934056n,
				transactionHash: "0x50f2b4936ca0dcc5baacfc2add6e842b7b9f246629cdb9df8a924c708fccd130",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x1967D8Af5Bd86A497fb3DD7899A020e47560dAAF"],
				},
			},
			{
				blockNumber: 15934056n,
				transactionHash: "0x624f722fe728d3ee244801e691108f2fa7a15209fa197b7973af523b948fabd8",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x1967D8Af5Bd86A497fb3DD7899A020e47560dAAF"],
				},
			},
			{
				blockNumber: 15934056n,
				transactionHash: "0x3676d144ce86481668650f1c60da3f78cbf85f5862c6b0409a44035f971f55a8",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x04DBA1194ee10112fE6C3207C0687DEf0e78baCf"],
				},
			},
			{
				blockNumber: 15934062n,
				transactionHash: "0x4430bf9af79d9b9c403ab47a0526d53fb0faa7340cb5916763b3699122e7c729",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x08b2eFdcdB8822EfE5ad0Eae55517cf5DC544251"],
				},
			},
			{
				blockNumber: 15934071n,
				transactionHash: "0x4c49c6a62d701983bd21cc143d26f1195671aa3d6902043c83ee0755937e2973",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x0Ee5067b06776A89CcC7dC8Ee369984AD7Db5e06"],
				},
			},
			{
				blockNumber: 15934071n,
				transactionHash: "0xccb787381b01b390d82a651714eb58711bd69d27a4494d366416b31fde0804c5",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x502371699497d08D5339c870851898D6D72521Dd"],
				},
			},
			{
				blockNumber: 15934072n,
				transactionHash: "0xdfc79b3fbe6e4ea7929ff44cdbede3ef6cba497b1c8f9fd4012403100efebc49",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x5A14E72060c11313E38738009254a90968F58f51"],
				},
			},
			{
				blockNumber: 15934074n,
				transactionHash: "0x7bab67582117fb64d6f3926da2af55206f972cef3dd68640501ad0e6d8c50920",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0xEFE301d259F525cA1ba74A7977b80D5b060B3ccA"],
				},
			},
			{
				blockNumber: 15971371n,
				transactionHash: "0x4afc7154e2c48183667979ea2c88bada74228bc4dc6f8e2f5e65509caf0f30c5",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x179f48C78f57A3A78f0608cC9197B8972921d1D2",
						"0x77777FeDdddFfC19Ff86DB637967013e6C6A116C",
						"0x3eFA30704D2b8BBAc821307230376556cF8CC39e",
						"0x746Aebc06D2aE31B71ac51429A19D54E797878E9",
						"0x2F50508a8a3D323B91336FA3eA6ae50E55f32185",
						"0xffbaC21a641Dcfe4552920138D90F3638B3c9fba",
					],
				},
			},
			{
				blockNumber: 15971419n,
				transactionHash: "0x79e496c2dae0219175583fd4cfad08c1650c92fb8a726b496b81dee077d01f50",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x5f6c97C6AD7bdd0AE7E0Dd4ca33A4ED3fDabD4D7",
						"0xf4B067dD14e95Bab89Be928c07Cb22E3c94E0DAA",
						"0x05E0b5B40B7b66098C2161A5EE11C5740A3A7C45",
						"0x23173fE8b96A4Ad8d2E17fB83EA5dcccdCa1Ae52",
						"0x538Ab61E8A9fc1b2f93b3dd9011d662d89bE6FE6",
						"0x94Be88213a387E992Dd87DE56950a9aef34b9448",
						"0xb04E030140b30C27bcdfaafFFA98C57d80eDa7B4",
						"0x6Bf694a291DF3FeC1f7e69701E3ab6c592435Ae7",
						"0x3aac1cC67c2ec5Db4eA850957b967Ba153aD6279",
						"0x723B78e67497E85279CB204544566F4dC5d2acA0",
						"0x0E3A09dDA6B20aFbB34aC7cD4A6881493f3E7bf7",
						"0x76D85B4C0Fc497EeCc38902397aC608000A06607",
						"0xCC84179FFD19A1627E79F8648d09e095252Bc418",
						"0xD5d6f8D9e784d0e26222ad3834500801a68D027D",
						"0x776198CCF446DFa168347089d7338879273172cF",
						"0xeDC5d01286f99A066559F60a585406f3878a033e",
						"0xD692Fd2D0b2Fbd2e52CFa5B5b9424bC981C30696",
						"0xDF3A408c53E5078af6e8fb2A85088D46Ee09A61b",
						"0x743494b60097A2230018079c02fe21a7B687EAA5",
						"0x94C92F096437ab9958fC0A37F09348f30389Ae79",
						"0x5efda50f22d34F262c29268506C5Fa42cB56A1Ce",
						"0xCEe71753C9820f063b38FDbE4cFDAf1d3D928A80",
						"0x88fd245fEdeC4A936e700f9173454D1931B4C307",
						"0x09193888b3f38C82dEdfda55259A82C0E7De875E",
						"0x5cab7692D4E94096462119ab7bF57319726Eed2A",
						"0x756C4628E57F7e7f8a459EC2752968360Cf4D1AA",
						"0xD82ed8786D7c69DC7e052F7A542AB047971E73d2",
						"0xB20c66C4DE72433F3cE747b58B86830c459CA911",
						"0x2573BAc39EBe2901B4389CD468F2872cF7767FAF",
						"0x653477c392c16b0765603074f157314Cc4f40c32",
						"0x407CcEeaA7c95d2FE2250Bf9F2c105aA7AAFB512",
						"0x833481186f16Cece3f1Eeea1a694c42034c3a0dB",
						"0xd8D7DE3349ccaA0Fde6298fe6D7b7d0d34586193",
						"0x8281Aa6795aDE17C8973e1aedcA380258Bc124F9",
						"0x57b2B8c82F065de8Ef5573f9730fC1449B403C9f",
						"0x84443CFd09A48AF6eF360C6976C5392aC5023a1F",
						"0xd47438C816c9E7f2E2888E060936a499Af9582b3",
						"0x330bdFADE01eE9bF63C209Ee33102DD334618e0a",
						"0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
						"0xdf231d99Ff8b6c6CBF4E9B9a945CBAcEF9339178",
						"0xaf4c0B70B2Ea9FB7487C7CbB37aDa259579fe040",
						"0xa5C2254e4253490C54cef0a4347fddb8f75A4998",
						"0xaf8d1839c3c67cf571aa74B5c12398d4901147B3",
						"0x242654336ca2205714071898f67E254EB49ACdCe",
						"0x01e2919679362dFBC9ee1644Ba9C6da6D6245BB1",
						"0x2FC93484614a34f26F7970CBB94615bA109BB4bf",
						"0x26903a5a198D571422b2b4EA08b56a37cbD68c89",
					],
				},
			},
			{
				blockNumber: 16177377n,
				transactionHash: "0x94234d073184e11a8da55e9ce4c7684dacc046c1a9eb674ca0195ba7c3fb0b53",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16177393n,
				transactionHash: "0x9a421191f7ca5a22b4a166886370917d019e148c0356900de12047a734da0561",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16177393n,
				transactionHash: "0x76b9656a96e713f0aa207acb184530a508a97e0cfcad1540d594d4a45de484e7",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16177393n,
				transactionHash: "0x92a731f698d9c61ad43ef35675e81aba410075452126ff419201fd104c480473",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16177393n,
				transactionHash: "0xeb1a810d440175c61fe529394cfed0b558614ee191a9cd90c3c39af6d876e5ab",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16177393n,
				transactionHash: "0xee7de52ba88f098337845c96a5c98a2ca3dbdb22018299c6f43a8b286ffd4a77",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16177393n,
				transactionHash: "0x1bded7ec8753315d49ff688d16e283d110730690c7f8f5526f634aeeabc0006b",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16177396n,
				transactionHash: "0xbb8ab9c56cb51727cdf1046a7a998d2b25ae831dfef014e108b5d6eaffef3ac0",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16177396n,
				transactionHash: "0x1dcdc6b09194503b1426b94564310ebcaad2c3ddaf3951b331b8834f734ba3e0",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16177399n,
				transactionHash: "0xd7051c81ef81174d2f2ab0fde95bd0a3d5c79a3d8d08b72dbe5553b7186d3b27",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16499173n,
				transactionHash: "0xd6b9396fea05e5ee1ad819002871e7ab54478dea89c16ce0491915bbf94dfea9",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x96Ad914cBA965130B19610f9cF0AC405c2b6661C",
						"0xDc450aa52D6B3918d3f6f89a13F3F2f28871479E",
						"0xc5873E3ed3bA425acD18dcc6b4Af99A02897363E",
						"0x6baD91120e2171950A7d9a70c15e816cf48cE0de",
						"0xDD4c48C0B24039969fC16D1cdF626eaB821d3384",
					],
				},
			},
			{
				blockNumber: 16499173n,
				transactionHash: "0xa2145df140a932f355c52c3be9b674afb1d3068679c69915603db11738f1f5b9",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x96Ad914cBA965130B19610f9cF0AC405c2b6661C",
						"0xDc450aa52D6B3918d3f6f89a13F3F2f28871479E",
						"0xc5873E3ed3bA425acD18dcc6b4Af99A02897363E",
						"0x6baD91120e2171950A7d9a70c15e816cf48cE0de",
						"0xDD4c48C0B24039969fC16D1cdF626eaB821d3384",
					],
				},
			},
			{
				blockNumber: 16499173n,
				transactionHash: "0x9cfbcab760ea4fd685034c253ddadca55036280505121d7f2aa89d650308b875",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x96Ad914cBA965130B19610f9cF0AC405c2b6661C",
						"0xDc450aa52D6B3918d3f6f89a13F3F2f28871479E",
						"0xc5873E3ed3bA425acD18dcc6b4Af99A02897363E",
						"0x6baD91120e2171950A7d9a70c15e816cf48cE0de",
						"0xDD4c48C0B24039969fC16D1cdF626eaB821d3384",
					],
				},
			},
			{
				blockNumber: 16535245n,
				transactionHash: "0x7a61100f5b06d1a9b0e4556630986823f9ef97f9a1cea14caf28e2989a5db3e8",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16535248n,
				transactionHash: "0x0f1f18899f5a0d7bcaaf2aa6babf5d0d1f59a62ecd14ddc2881227bf523c16b0",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16535250n,
				transactionHash: "0xc4d350f935bd44176db6596b42e9e2a340c9d1bccb465e2d765d287e6ded0ece",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16535253n,
				transactionHash: "0x5df2467e5ea076c25890434b92eeb59c642fe708c6717b714319edf6eac16f07",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16535255n,
				transactionHash: "0x1fb6ae1af08aa0924be39ed86007f3e582947aec5ee911e8d0485b8c35afe7ad",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16535260n,
				transactionHash: "0xf35549298445c2ec40b98e7e6c50f9d4926d3950e23e0b76cedcd0c8b7ffd1cf",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16535260n,
				transactionHash: "0x92e6c67478412c7c6c480976dfc1236adf84ab30e253bbb520aca2e95669280c",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16535263n,
				transactionHash: "0xf5190c48999aad2945ae356b6b9069aea9dd2d6286fb60bd966cb5042c8bca85",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16535266n,
				transactionHash: "0x4a3e8be99262156e3e20c7bf79d57b1acd973845a4153bd7f88e4ed375bd57ad",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16535268n,
				transactionHash: "0xf5e2734393ee064a51b13e4ad717128b7fafead7ee975455107d6cb945e24011",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x433830Bf9f152C4bfD444aFC684450Fd9F33494f"],
				},
			},
			{
				blockNumber: 16537355n,
				transactionHash: "0x1c6ff0f3228460a35595ba73aef70ec7df5063fca24d1567bc3127490931cda7",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x39D908dac893CBCB53Cc86e0ECc369aA4DeF1A29"],
				},
			},
			{
				blockNumber: 16734670n,
				transactionHash: "0x4ecadd3313e1e8c5db0ea45143b47986c90f1b86372e4a559bbca4cfb92ddc4c",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x5d4163fAF150D2Ba76F5D15B18cE841169AcDaC1"],
				},
			},
			{
				blockNumber: 16734673n,
				transactionHash: "0xaef4af4268d9ee47fb03e7c28fb4cf1c9f9d2055952703c0c2c8c16cbbce00e6",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x5d4163fAF150D2Ba76F5D15B18cE841169AcDaC1"],
				},
			},
			{
				blockNumber: 16734675n,
				transactionHash: "0xdff7a51378b999af1f425b25fe1500f53afe78d693b6597af2e16ddd6334c604",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x5d4163fAF150D2Ba76F5D15B18cE841169AcDaC1"],
				},
			},
			{
				blockNumber: 16870929n,
				transactionHash: "0x2e08049dc7b9204b11403dfd80d987e4a47d2e1fad529eaa968d8b130e93dcee",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 16870934n,
				transactionHash: "0xd74753339659e94d44b45658f15880b531e5396f6138e099528ae51468895084",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 16870934n,
				transactionHash: "0xc2b3e53f0fddb82cbd1dc68413e1216e7a355ca42aa978a2dfb6d1f010fb4334",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 16870936n,
				transactionHash: "0x8459bd82b0a2b46fcaa843c33d5217bd983314b03432031e2be9fb515610f3f9",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 16870969n,
				transactionHash: "0x37ef4ce0525091f884c00abc7c86ea7c2488ea370328742f249b850ae41feef7",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 16870969n,
				transactionHash: "0x2b0e99821e1d0d3f1e75c103c6276565cf45a34b933b52411051d1b7fb779188",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 16870969n,
				transactionHash: "0x83d6e9d224a6bb9ab0627258bacd1ee0b7a595f9993e4e79f5700bc5ffecb445",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 16870969n,
				transactionHash: "0xab4383f727fb5945be0b75531270df254a45c33e1cbf8b12f55dba0d14913fae",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 16870969n,
				transactionHash: "0x0708a30a4099ae82d0c9d90092849cf5f806b86238ca2f1d5d3beaf857cf89af",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 16870969n,
				transactionHash: "0x128c422516d683a9dfc9e917abaa9500179757270824d9c0e5940dbce00784eb",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x818FaAbD112FE24cC5d8B56A2B8dd0E1f370f330"],
				},
			},
			{
				blockNumber: 17080812n,
				transactionHash: "0x0c3335cd81db77e89c5265ac9758c1f904181d8924260fbfe57f1fe99bc18dee",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xa108dfde99962808a7eD5C92439ec330717170ac",
						"0x1482CDf06702CA71eb8908ae699f0B36A2b16f2f",
					],
				},
			},
			{
				blockNumber: 17080812n,
				transactionHash: "0x31c89eddb2190abed62b17e6a2a9f56a409898498658f42e7c8fa4b48195809f",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xa108dfde99962808a7eD5C92439ec330717170ac",
						"0x1482CDf06702CA71eb8908ae699f0B36A2b16f2f",
					],
				},
			},
			{
				blockNumber: 17080812n,
				transactionHash: "0x869b776f3d6f1263f3ea238d6b247e1e7e9eb891a8c17bb2202af3d80d5ab54a",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xa108dfde99962808a7eD5C92439ec330717170ac",
						"0x1482CDf06702CA71eb8908ae699f0B36A2b16f2f",
					],
				},
			},
			{
				blockNumber: 17080812n,
				transactionHash: "0x8d923cad83c33ee0492f29d896b99f59183534b972060dfd168e59d6b16c3b49",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xa108dfde99962808a7eD5C92439ec330717170ac",
						"0x1482CDf06702CA71eb8908ae699f0B36A2b16f2f",
					],
				},
			},
			{
				blockNumber: 17080814n,
				transactionHash: "0x87f66624b6174d0f4274353cbd93a217383d17f3da62c0594315a9bb45b3fa78",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xa108dfde99962808a7eD5C92439ec330717170ac",
						"0x1482CDf06702CA71eb8908ae699f0B36A2b16f2f",
					],
				},
			},
			{
				blockNumber: 17080862n,
				transactionHash: "0x82e81e00ae25ca89d23f726709b827056addd11f40231b2e24f8e097f7687af9",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xa108dfde99962808a7eD5C92439ec330717170ac",
						"0x1482CDf06702CA71eb8908ae699f0B36A2b16f2f",
					],
				},
			},
			{
				blockNumber: 17080862n,
				transactionHash: "0x4e164e83e17fa8e44918a1bcde5db04113362e28d05749398bc9097650b4d1cc",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xa108dfde99962808a7eD5C92439ec330717170ac",
						"0x1482CDf06702CA71eb8908ae699f0B36A2b16f2f",
					],
				},
			},
			{
				blockNumber: 17080862n,
				transactionHash: "0x12dac0c42dc782c2b19171414712ffa3ab838e79b5b2c86ab7fbf004e1ccf9b5",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xa108dfde99962808a7eD5C92439ec330717170ac",
						"0x1482CDf06702CA71eb8908ae699f0B36A2b16f2f",
					],
				},
			},
			{
				blockNumber: 17117184n,
				transactionHash: "0x8eab4d9cf47d10b0c3075c01cd9300d2461090e35dd5255c6ffb084baa2298b2",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x5f6c97C6AD7bdd0AE7E0Dd4ca33A4ED3fDabD4D7",
						"0xf4B067dD14e95Bab89Be928c07Cb22E3c94E0DAA",
						"0x05E0b5B40B7b66098C2161A5EE11C5740A3A7C45",
						"0x23173fE8b96A4Ad8d2E17fB83EA5dcccdCa1Ae52",
						"0x538Ab61E8A9fc1b2f93b3dd9011d662d89bE6FE6",
						"0x94Be88213a387E992Dd87DE56950a9aef34b9448",
						"0xb04E030140b30C27bcdfaafFFA98C57d80eDa7B4",
						"0x6Bf694a291DF3FeC1f7e69701E3ab6c592435Ae7",
						"0x3aac1cC67c2ec5Db4eA850957b967Ba153aD6279",
						"0x723B78e67497E85279CB204544566F4dC5d2acA0",
						"0x0E3A09dDA6B20aFbB34aC7cD4A6881493f3E7bf7",
						"0x76D85B4C0Fc497EeCc38902397aC608000A06607",
						"0xCC84179FFD19A1627E79F8648d09e095252Bc418",
						"0xD5d6f8D9e784d0e26222ad3834500801a68D027D",
						"0x776198CCF446DFa168347089d7338879273172cF",
						"0xeDC5d01286f99A066559F60a585406f3878a033e",
						"0xD692Fd2D0b2Fbd2e52CFa5B5b9424bC981C30696",
						"0xDF3A408c53E5078af6e8fb2A85088D46Ee09A61b",
						"0x743494b60097A2230018079c02fe21a7B687EAA5",
						"0x94C92F096437ab9958fC0A37F09348f30389Ae79",
						"0x5efda50f22d34F262c29268506C5Fa42cB56A1Ce",
						"0xCEe71753C9820f063b38FDbE4cFDAf1d3D928A80",
						"0x88fd245fEdeC4A936e700f9173454D1931B4C307",
						"0x09193888b3f38C82dEdfda55259A82C0E7De875E",
						"0x5cab7692D4E94096462119ab7bF57319726Eed2A",
						"0x756C4628E57F7e7f8a459EC2752968360Cf4D1AA",
						"0xD82ed8786D7c69DC7e052F7A542AB047971E73d2",
						"0xB20c66C4DE72433F3cE747b58B86830c459CA911",
						"0x2573BAc39EBe2901B4389CD468F2872cF7767FAF",
						"0x653477c392c16b0765603074f157314Cc4f40c32",
						"0x407CcEeaA7c95d2FE2250Bf9F2c105aA7AAFB512",
						"0x833481186f16Cece3f1Eeea1a694c42034c3a0dB",
						"0xd8D7DE3349ccaA0Fde6298fe6D7b7d0d34586193",
						"0x8281Aa6795aDE17C8973e1aedcA380258Bc124F9",
						"0x57b2B8c82F065de8Ef5573f9730fC1449B403C9f",
						"0x84443CFd09A48AF6eF360C6976C5392aC5023a1F",
						"0xd47438C816c9E7f2E2888E060936a499Af9582b3",
						"0x330bdFADE01eE9bF63C209Ee33102DD334618e0a",
						"0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
						"0xdf231d99Ff8b6c6CBF4E9B9a945CBAcEF9339178",
						"0xaf4c0B70B2Ea9FB7487C7CbB37aDa259579fe040",
						"0xa5C2254e4253490C54cef0a4347fddb8f75A4998",
						"0xaf8d1839c3c67cf571aa74B5c12398d4901147B3",
						"0x242654336ca2205714071898f67E254EB49ACdCe",
						"0x01e2919679362dFBC9ee1644Ba9C6da6D6245BB1",
						"0x2FC93484614a34f26F7970CBB94615bA109BB4bf",
						"0x26903a5a198D571422b2b4EA08b56a37cbD68c89",
					],
				},
			},
			{
				blockNumber: 17117191n,
				transactionHash: "0x2f003383cf9edbdaeead05c80788da5894db438401793708af4b1b7005da3c8a",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x4F47Bc496083C727c5fbe3CE9CDf2B0f6496270c"],
				},
			},
			{
				blockNumber: 17117207n,
				transactionHash: "0x57f4cdef020828cdc81db1c988c391dc2bfe4da1e419d21eae25899fea8c8912",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x4F47Bc496083C727c5fbe3CE9CDf2B0f6496270c"],
				},
			},
			{
				blockNumber: 17117268n,
				transactionHash: "0x68303aa14e6e32deb044cdfe15f034f060f85aa971e07f98c90c00ddb283ef2e",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x4F47Bc496083C727c5fbe3CE9CDf2B0f6496270c"],
				},
			},
			{
				blockNumber: 17118381n,
				transactionHash: "0xa7b9cff7f34bc3642ec27513c70fb1f28dcd1de9b40a9297065ee7176b6deed5",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x4F47Bc496083C727c5fbe3CE9CDf2B0f6496270c",
						"0x4F47Bc496083C727c5fbe3CE9CDf2B0f6496270c",
						"0x4F47Bc496083C727c5fbe3CE9CDf2B0f6496270c",
					],
				},
			},
			{
				blockNumber: 18042792n,
				transactionHash: "0x7cc995252a9da4ce4f08d32a2b9a6ceede7258412b025fad07067c47b5110c55",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xdcbEfFBECcE100cCE9E4b153C4e15cB885643193",
						"0x5f48C2A71B2CC96e3F0CCae4E39318Ff0dc375b2",
						"0x5A7a51bFb49F190e5A6060a5bc6052Ac14a3b59f",
						"0xeD6e0A7e4Ac94D976eeBfB82ccf777A3c6baD921",
						"0x797d7Ae72EbddCDea2a346c1834E04d1F8dF102b",
						"0x931546D9e66836AbF687d2bc64B30407bAc8C568",
						"0x43fa21d92141BA9db43052492E0DeEE5aa5f0A93",
						"0x6Be0aE71e6c41f2f9D0D1A3B8d0f75E6f6A0b46e",
					],
				},
			},
			{
				blockNumber: 18222796n,
				transactionHash: "0x9da9c2d5033200548dc370fca21506f47bf3e987b4cda5e372952c3be132460c",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x9C2Bc757B66F24D60F016B6237F8CdD414a879Fa"],
				},
			},
			{
				blockNumber: 18272728n,
				transactionHash: "0x7e1771f3798da1980840bb8c66524667bdb5be1e1447c7127c6b631f2fcfacb0",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x961C5Be54a2ffC17CF4Cb021d863c42daCd47Fc1"],
				},
			},
			{
				blockNumber: 19562392n,
				transactionHash: "0xa2c14db7f1a255fbb6434b9a829b5cf2759d1637ef46e4ad2d1cd9391f4ae263",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x38735f03b30FbC022DdD06ABED01F0Ca823C6a94",
						"0x97B1043ABD9E6FC31681635166d430a458D14F9C",
						"0xb6f5ec1A0a9cd1526536D3F0426c429529471F40",
						"0x9C2Bc757B66F24D60F016B6237F8CdD414a879Fa",
						"0x530A64c0Ce595026a4A556b703644228179E2d57",
						"0xFAC583C0cF07Ea434052c49115a4682172aB6b4F",
						"0x983a81ca6FB1e441266D2FbcB7D8E530AC2E05A2",
						"0xf3701F445b6BDaFeDbcA97D1e477357839e4120D",
						"0xE950DC316b836e4EeFb8308bf32Bf7C72a1358FF",
						"0x21B8d56BDA776bbE68655A16895afd96F5534feD",
						"0x175d44451403Edf28469dF03A9280c1197ADb92c",
					],
				},
			},
			{
				blockNumber: 19783740n,
				transactionHash: "0x4acf430775d025f18b53f77a2a9d962ad6aae85e99c7ab2e801e6204831be807",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x19F8f2B0915Daa12a3f5C9CF01dF9E24D53794F7"],
				},
			},
			{
				blockNumber: 20463655n,
				transactionHash: "0x5d5f9971c3ce1f2cce81bff936a64e117846e41f960534fb979098e2cbb25728",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0xE1D865c3D669dCc8c57c8D023140CB204e672ee4"],
				},
			},
			{
				blockNumber: 20864353n,
				transactionHash: "0xde9959ccafb8e3282a85aebad93dbeb72d19b94deb7accbde78caf701d59d27c",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x0931cA4D13BB4ba75D9B7132AB690265D749a5E7"],
				},
			},
			{
				blockNumber: 21331994n,
				transactionHash: "0x9fcf8b1942c0d21a1794d61f4833988ce84ce1f58a6c9cac75206c9f8771b769",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x1999EF52700c34De7EC2b68a28aAFB37db0C5ade"],
				},
			},
			{
				blockNumber: 21918916n,
				transactionHash: "0xeca25e73a3637f73f742441966e9fecb5bb76bfa2be999d7b2247d0405d473f9",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x3051Ca7cB7f6C599fA2f27385AD75010cf0f2bbF",
						"0x002471b8A185f9980708d0eAEC5B289714F56f8d",
					],
				},
			},
			{
				blockNumber: 22097863n,
				transactionHash: "0x75f213aa421ca2bf728b1b90f9e08dba038708d5483dac1292a501e9406251d4",
				eventName: "SanctionedAddressesRemoved",
				args: {
					addrs: [
						"0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc",
						"0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936",
						"0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF",
						"0xA160cdAB225685dA1d56aa342Ad8841c3b53f291",
						"0xD4B88Df4D29F5CedD6857912842cff3b20C8Cfa3",
						"0xFD8610d20aA15b7B2E3Be39B396a1bC3516c7144",
						"0x07687e702b410Fa43f4cB4Af7FA097918ffD2730",
						"0x23773E65ed146A459791799d01336DB287f25334",
						"0x22aaA7720ddd5388A3c0A3333430953C68f1849b",
						"0x03893a7c7463AE47D46bc7f091665f1893656003",
						"0x2717c5e28cf931547B621a5dddb772Ab6A35B701",
						"0xD21be7248e0197Ee08E0c20D4a96DEBdaC3D20Af",
						"0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa9D",
						"0xDD4c48C0B24039969fC16D1cdF626eaB821d3384",
						"0xd96f2B1c14Db8458374d9Aca76E26c3D18364307",
						"0x169AD27A470D064DEDE56a2D3ff727986b15D52B",
						"0x0836222F2B2B24A3F36f98668Ed8F0B38D1a872f",
						"0x178169B423a011fff22B9e3F3abeA13414dDD0F1",
						"0x610B717796ad172B316836AC95a2ffad065CeaB4",
						"0xbB93e510BbCD0B7beb5A853875f9eC60275CF498",
						"0x84443CFd09A48AF6eF360C6976C5392aC5023a1F",
						"0xd47438C816c9E7f2E2888E060936a499Af9582b3",
						"0x330bdFADE01eE9bF63C209Ee33102DD334618e0a",
						"0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD",
						"0xdf231d99Ff8b6c6CBF4E9B9a945CBAcEF9339178",
						"0xaf4c0B70B2Ea9FB7487C7CbB37aDa259579fe040",
						"0xa5C2254e4253490C54cef0a4347fddb8f75A4998",
						"0xaf8d1839c3c67cf571aa74B5c12398d4901147B3",
						"0x6Bf694a291DF3FeC1f7e69701E3ab6c592435Ae7",
						"0x3aac1cC67c2ec5Db4eA850957b967Ba153aD6279",
						"0x723B78e67497E85279CB204544566F4dC5d2acA0",
						"0x0E3A09dDA6B20aFbB34aC7cD4A6881493f3E7bf7",
						"0x76D85B4C0Fc497EeCc38902397aC608000A06607",
						"0xCC84179FFD19A1627E79F8648d09e095252Bc418",
						"0xD5d6f8D9e784d0e26222ad3834500801a68D027D",
						"0x407CcEeaA7c95d2FE2250Bf9F2c105aA7AAFB512",
						"0x833481186f16Cece3f1Eeea1a694c42034c3a0dB",
						"0xd8D7DE3349ccaA0Fde6298fe6D7b7d0d34586193",
						"0x8281Aa6795aDE17C8973e1aedcA380258Bc124F9",
						"0x57b2B8c82F065de8Ef5573f9730fC1449B403C9f",
						"0x05E0b5B40B7b66098C2161A5EE11C5740A3A7C45",
						"0x23173fE8b96A4Ad8d2E17fB83EA5dcccdCa1Ae52",
						"0x538Ab61E8A9fc1b2f93b3dd9011d662d89bE6FE6",
						"0x94Be88213a387E992Dd87DE56950a9aef34b9448",
						"0x242654336ca2205714071898f67E254EB49ACdCe",
						"0x776198CCF446DFa168347089d7338879273172cF",
						"0xeDC5d01286f99A066559F60a585406f3878a033e",
						"0xD692Fd2D0b2Fbd2e52CFa5B5b9424bC981C30696",
						"0xCa0840578f57fE71599D29375e16783424023357",
						"0xDF3A408c53E5078af6e8fb2A85088D46Ee09A61b",
						"0x743494b60097A2230018079c02fe21a7B687EAA5",
						"0x94C92F096437ab9958fC0A37F09348f30389Ae79",
						"0x5efda50f22d34F262c29268506C5Fa42cB56A1Ce",
						"0x2F50508a8a3D323B91336FA3eA6ae50E55f32185",
						"0xCEe71753C9820f063b38FDbE4cFDAf1d3D928A80",
						"0xffbaC21a641Dcfe4552920138D90F3638B3c9fba",
						"0x179f48C78f57A3A78f0608cC9197B8972921d1D2",
						"0xb04E030140b30C27bcdfaafFFA98C57d80eDa7B4",
						"0x77777FeDdddFfC19Ff86DB637967013e6C6A116C",
						"0x3eFA30704D2b8BBAc821307230376556cF8CC39e",
						"0x746Aebc06D2aE31B71ac51429A19D54E797878E9",
						"0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b",
						"0x5f6c97C6AD7bdd0AE7E0Dd4ca33A4ED3fDabD4D7",
						"0xf4B067dD14e95Bab89Be928c07Cb22E3c94E0DAA",
						"0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2",
						"0x01e2919679362dFBC9ee1644Ba9C6da6D6245BB1",
						"0x2FC93484614a34f26F7970CBB94615bA109BB4bf",
						"0x26903a5a198D571422b2b4EA08b56a37cbD68c89",
						"0xB20c66C4DE72433F3cE747b58B86830c459CA911",
						"0x2573BAc39EBe2901B4389CD468F2872cF7767FAF",
						"0x527653eA119F3E6a1F5BD18fbF4714081D7B31ce",
						"0x653477c392c16b0765603074f157314Cc4f40c32",
						"0x88fd245fEdeC4A936e700f9173454D1931B4C307",
						"0x09193888b3f38C82dEdfda55259A82C0E7De875E",
						"0x5cab7692D4E94096462119ab7bF57319726Eed2A",
						"0x756C4628E57F7e7f8a459EC2752968360Cf4D1AA",
						"0x722122dF12D4e14e13Ac3b6895a86e84145b6967",
						"0x94A1B5CdB22c43faab4AbEb5c74999895464Ddaf",
						"0xb541fc07bC7619fD4062A54d96268525cBC6FfEF",
						"0xD82ed8786D7c69DC7e052F7A542AB047971E73d2",
						"0xF67721A2D8F736E75a49FdD7FAd2e31D8676542a",
						"0x9AD122c22B14202B4490eDAf288FDb3C7cb3ff5E",
						"0xD691F27f38B395864Ea86CfC7253969B409c362d",
						"0xaEaaC358560e11f52454D997AAFF2c5731B6f8a6",
						"0x1356c899D8C9467C7f71C195612F8A395aBf2f0a",
						"0xA60C772958a3eD56c1F15dD055bA37AC8e523a0D",
						"0xBA214C1c1928a32Bffe790263E38B4Af9bFCD659",
						"0xb1C8094B234DcE6e03f10a5b673c1d8C69739A00",
						"0xF60dD140cFf0706bAE9Cd734Ac3ae76AD9eBC32A",
						"0x8589427373D6D84E98730D7795D8f6f8731FDA16",
					],
				},
			},
			{
				blockNumber: 22597967n,
				transactionHash: "0xe545b60e07fa17e4d1f60a75792c3e0e5b3a5534fd0f88bff73d960922352301",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0xd5ED34b52AC4ab84d8FA8A231a3218bbF01Ed510"],
				},
			},
			{
				blockNumber: 22782345n,
				transactionHash: "0x149024732f2aa0d0b8aa2a6b027575e49e1d86164772bae2197baac6e96638ba",
				eventName: "SanctionedAddressesRemoved",
				args: {
					addrs: ["0x6aCDFBA02D390b97Ac2b2d42A63E85293BCc160e"],
				},
			},
			{
				blockNumber: 23199109n,
				transactionHash: "0x7af621eac1384afac8e4134251a7eecaf1383b2c66f812e3cd4736b3ad3aa50b",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x12de548F79a50D2bd05481C8515C1eF5183666a9"],
				},
			},
			{
				blockNumber: 23199126n,
				transactionHash: "0x9af8f9b5506799122f2ddf3617a2e7aa144293a90c9b5f6b36f1af6ee00b942e",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0x12de548F79a50D2bd05481C8515C1eF5183666a9"],
				},
			},
			{
				blockNumber: 23420862n,
				transactionHash: "0x39872c5f5e6c224a10d438bfc69ac95d103fb628493c9e65c15b3bbfa30b8afd",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0xE3D35f68383732649669aA990832E017340DbcA5"],
				},
			},
			{
				blockNumber: 23421049n,
				transactionHash: "0x62e64f973499d579edf48c506b8f979f1930f121646b146257e8b09d254423f1",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: ["0xE3D35f68383732649669aA990832E017340DbcA5"],
				},
			},
			{
				blockNumber: 23421215n,
				transactionHash: "0x5f8963c687687e833dafad78645b050680b65751bd9d3e4772bf985b8f99812a",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0x532B77B33A040587e9FD1800088225f99b8B0E8A",
						"0xDb2720ebAd55399117ddB4C4a4afd9a4CCAda8fE",
					],
				},
			},
			{
				blockNumber: 23421231n,
				transactionHash: "0x58a452f263c52c006aa3b1d0255a57c99ad4e27b83dd81545a36f833dc2b16dd",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xd5ED34b52AC4ab84d8FA8A231a3218bbF01Ed510",
						"0x12de548F79a50D2bd05481C8515C1eF5183666a9",
					],
				},
			},
			{
				blockNumber: 24687198n,
				transactionHash: "0x5446ac44bc6aa4558911d71b95627a7dedf97d7ebc248bdd9644a617e15cd72f",
				eventName: "SanctionedAddressesAdded",
				args: {
					addrs: [
						"0xFda1Ec4A6178d4916b001a065422D31EBE5F62FF",
						"0xcB74874f1e06Fcf80A306e06e5379A44B488bA2D",
						"0x95584C303FCd48AF5c6B9873015f2AD0ca84EaE3",
						"0x9Be599d7867f5E1a2D7Ec6dB9710dF2b98A15573",
						"0x76EA76CA4Eb727f18956aB93445a94c5280412B9",
						"0x0330070FD38Ec3bB94F58FA55D40368271E9e54A",
						"0x747AFB5c7A7fc34B547cD0FDEbf9b91759C5a52b",
						"0xd04E33461FEA8302c5E1e13895b60cEe8AEfda7F",
						"0xb637F84b66876ebf609C2A4208905F9ddAC9d075",
						"0xFb3eFf152ea55D1BfA04Dbdd509A80fD7b72cdEB",
					],
				},
			},
		],
	},
} as Record<string, SanctionsListSeedData | undefined>;
